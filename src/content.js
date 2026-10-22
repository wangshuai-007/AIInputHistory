(async function startExtension(namespace) {
  "use strict";

  if (globalThis.__aiInputHistoryLoaded) return;
  globalThis.__aiInputHistoryLoaded = true;

  const adapter = namespace.InputAdapter;
  const store = new namespace.HistoryStore();
  const historyNavigator = new namespace.HistoryNavigator(store, adapter);
  let activeInput = null;
  let activeContext = null;
  let draftTimer = null;
  let snapshotTimer = null;
  let lastSnapshotText = "";
  let storageSyncTimer = null;
  let snapshotInFlight = false;
  let recordQueue = Promise.resolve();
  let promptQueue = null;

  window.addEventListener("keydown", handleHistoryArrowKeydown, true);

  const settings = await store.getSettings();
  namespace.i18n.setLanguage(settings.language);
  let liveSettings = settings;
  if (!namespace.SiteProfiles.isAllowedSite(location.hostname, settings.customDomains, location.pathname)) return;
  namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
  const queueSupported = namespace.promptQueueModel?.supportedSite(location.hostname) === true;

  // An explicit Pro-enable action or the manual plan button requests this
  // read-only classification. Never return full session JSON, IDs or tokens.
  if (namespace.proQuotaModel?.isChatGPT(location.hostname)
    && globalThis.top === globalThis) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== "AIH_PRO_ACCOUNT_PLAN_READ") return false;
      namespace.proUsageModel.readCurrentAccountPlan()
        .then((result) => {
          sendResponse(result);
          // Log only a reason code and classification outcome, never the
          // session payload, cookies, bearer token, email or workspace IDs.
          appendNotificationDebug("pro-account-plan-read", {
            source: result?.source || "chatgpt-page",
            reason: result?.seatReason || result?.reason || "classified",
            status: result?.ok ? "ok" : "failed",
            accountPlan: result?.plan || "unknown",
            seatField: result?.seatField || null,
            seatTypeCode: result?.seatTypeCode || null,
            seatValueKind: result?.seatValueKind || null,
            seatMatchedBy: result?.seatMatchedBy || null,
            seatFieldKeys: result?.seatFieldKeys || null,
            seatRecordCount: result?.seatRecordCount ?? null,
            seatMapping: result?.seatMapping || null
          });
        })
        .catch(() => sendResponse({ ok: false, reason: "session-read-error" }));
      return true;
    });
  }

  const panel = new namespace.HistoryPanel(
    store,
    (text) => { if (activeInput) adapter.setText(activeInput, text); },
    () => historyNavigator.reset()
  );
  const timingSession = {
    save: (state) => timingSessionMessage("AIH_TIMING_SESSION_SAVE", { state }),
    load: async (site = location.hostname, path = location.pathname) =>
      (await timingSessionMessage("AIH_TIMING_SESSION_LOAD", { site, path })).state,
    clear: (state) => timingSessionMessage("AIH_TIMING_SESSION_CLEAR", {
      requestId: state?.requestId || "", site: state?.site || location.hostname, path: state?.path || location.pathname
    }),
    finalize: (state, status) => timingSessionMessage("AIH_TIMING_SESSION_FINALIZE", { ...state, status }),
    debug: (entry) => appendNotificationDebug(entry.stage, entry)
  };
  // Read only the visible first-party ChatGPT quota/modals. This does not
  // request hidden account endpoints and never transmits conversation text.
  const proQuotaObserver = namespace.proQuotaModel?.isChatGPT(location.hostname)
    ? new namespace.proQuotaModel.Observer({
      onSignal: (signal) => timingSessionMessage("AIH_PRO_QUOTA_OBSERVE", { signal })
    }) : null;
  if (settings.trackProUsage === true) proQuotaObserver?.start();
  const proModelBadge = namespace.ProModelBadge && namespace.proQuotaModel?.isChatGPT(location.hostname)
    ? new namespace.ProModelBadge() : null;
  proModelBadge?.setSettings(settings);
  proModelBadge?.start();
  if (proModelBadge) {
    chrome.storage.local.get(["aiInputHistoryProUsage", "aiInputHistoryProQuotaStatus"], (stored) => {
      if (chrome.runtime.lastError) return;
      proModelBadge.updateUsage(stored?.aiInputHistoryProUsage);
      proModelBadge.updateQuota(stored?.aiInputHistoryProQuotaStatus);
    });
  }
  const sidebarTiming = namespace.SidebarTiming && namespace.requestTimingModel?.isSupported(location.hostname)
    ? new namespace.SidebarTiming({
      onStatus: (state) => timingSessionMessage("AIH_TIMING_SESSION_OBSERVE", state),
      onDiagnostic: (event) => appendNotificationDebug(event.stage, event)
    }) : null;
  sidebarTiming?.setEnabled(settings.trackRequestTime === true);
  sidebarTiming?.start();
  if (sidebarTiming) {
    chrome.storage.local.get("aiInputHistoryActiveTimingByUrl", (result) => {
      if (!chrome.runtime.lastError) sidebarTiming.update(result?.aiInputHistoryActiveTimingByUrl);
    });
  }
  const requestTiming = new namespace.RequestTiming({
    store,
    onTick: (elapsed, paused) => panel.timingView.update(liveSettings.trackRequestTime ? elapsed : null, paused),
    onComplete: notifyRequestCompleted,
    onGenerationConfirmed: (request) => recordProUsageFromGeneration(request),
    onDiagnostic: (event) => appendNotificationDebug(
      event.reason === "stale-streaming-ignored" ? "timing-stale-streaming-resolved" : "timing-finish-deferred", {
        type: event.status, reason: event.reason, detectionTrigger: event.trigger,
        durationMs: event.elapsedMs, page: location.hostname,
        requestId: event.requestId || null, conversationId: event.conversationId || null,
        pausedDurationMs: event.pausedDurationMs || 0, source: "content"
      }),
    session: timingSession
  });
  panel.setStopTimingHandler?.(() => {
    if (!requestTiming.active) return;
    requestTiming.finish("cancelled");
    promptQueue?.onRequestFinished?.({ status: "cancelled", manual: true });
  });
  requestTiming.setEnabled((queueSupported && settings.queueEnabled !== false) || settings.trackRequestTime
    || settings.trackProUsage || settings.completionNotification?.enabled === true);
  await requestTiming.restore(location.hostname);
  let observedTimingPath = location.pathname;
  const reconcileTimingRoute = () => {
    const path = location.pathname;
    if (path === observedTimingPath) return;
    observedTimingPath = path;
    sidebarTiming?.render();
    if (requestTiming.active && requestTiming.acceptPath(requestTiming.active, path)) return;
    requestTiming.suspend();
    requestTiming.restore(location.hostname, path)
      .catch((error) => console.warn("[AI 输入历史] 切换会话后恢复计时失败", error));
  };
  if (namespace.requestTimingModel.isSupported(location.hostname)) {
    window.addEventListener("popstate", reconcileTimingRoute);
    setInterval(reconcileTimingRoute, 400);
  }
  if (queueSupported && typeof namespace.PromptQueue === "function") {
    promptQueue = new namespace.PromptQueue({
      store,
      adapter,
      getInput: () => activeInput?.isConnected ? activeInput : adapter.findComposer(document, [panel.host, promptQueue?.shadow]),
      isRequestActive: () => Boolean(requestTiming.active),
      getRequestStartedAt: () => requestTiming.active?.startedAt || 0,
      enabled: settings.queueEnabled !== false
    });
    await promptQueue.init();
    panel.setQueueToggleHandler?.(async (enabled) => {
      const next = await store.patchSettings({ queueEnabled: enabled });
      liveSettings = next;
      promptQueue.setEnabled(next.queueEnabled);
      requestTiming.setEnabled((queueSupported && next.queueEnabled) || next.trackRequestTime
        || next.trackProUsage || next.completionNotification?.enabled === true);
      return next.queueEnabled;
    }, settings.queueEnabled !== false);
  }
  namespace.captureSiteIcon(store, location.hostname).then(async (dataUrl) => {
    if (!dataUrl) return;
    namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
    if (panel.isOpen()) await panel.loadSites();
  }).catch((error) => console.warn("[AI 输入历史] 读取网站图标失败", error));
  panel.setLauncherEnabled(settings.launcherEnabled);
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[namespace.STORAGE_KEYS.proUsage]) {
      proModelBadge?.updateUsage(changes[namespace.STORAGE_KEYS.proUsage].newValue);
    }
    if (changes[namespace.STORAGE_KEYS.proQuota]) {
      proModelBadge?.updateQuota(changes[namespace.STORAGE_KEYS.proQuota].newValue);
    }
    const timingChange = changes["aiInputHistoryActiveTimingByUrl"];
    if (timingChange) sidebarTiming?.update(timingChange.newValue);
    if (timingChange && namespace.requestTimingModel.isSupported(location.hostname)) {
      const requestId = requestTiming.active?.requestId;
      const before = Object.values(timingChange.oldValue || {});
      const after = Object.values(timingChange.newValue || {});
      const matching = after.find((state) => state?.requestId === requestId);
      if (matching) requestTiming.syncPause?.(matching);
      if (requestId && before.some((state) => state?.requestId === requestId)
        && !after.some((state) => state?.requestId === requestId)) {
        // Another tab completed or superseded this conversation; do not send a second notification.
        requestTiming.suspend({ persist: false });
        promptQueue?.onRequestFinished?.({ status: "completed-elsewhere" });
      }
      if (!requestTiming.active && after.some((state) =>
        namespace.requestTimingModel.sameConversationPath(state?.path, location.pathname))) {
        requestTiming.restore(location.hostname, location.pathname)
          .catch((error) => console.warn("[AI 输入历史] 同步其他标签页计时失败", error));
      }
    }
    const nextSettings = changes[namespace.STORAGE_KEYS.settings]?.newValue;
    if (nextSettings) {
      liveSettings = namespace.historyModel.sanitizeSettings(nextSettings);
      requestTiming.setEnabled((queueSupported && liveSettings.queueEnabled) || liveSettings.trackRequestTime
        || liveSettings.trackProUsage || liveSettings.completionNotification?.enabled === true);
      sidebarTiming?.setEnabled(liveSettings.trackRequestTime === true);
      proModelBadge?.setSettings(liveSettings);
      if (liveSettings.trackProUsage) proQuotaObserver?.start();
      else proQuotaObserver?.stop();
      promptQueue?.setEnabled?.(liveSettings.queueEnabled);
      panel.setQueueEnabled?.(liveSettings.queueEnabled);
      panel.setLauncherEnabled(nextSettings.launcherEnabled !== false);
      if (liveSettings.launcherEnabled) discoverComposer();
      if (changes[namespace.STORAGE_KEYS.settings]?.oldValue?.language !== liveSettings.language) panel.setLanguage(liveSettings.language);
      if (changes[namespace.STORAGE_KEYS.settings]?.oldValue?.snapshotSeconds !== nextSettings.snapshotSeconds) scheduleSnapshots();
    }
    if (changes[namespace.STORAGE_KEYS.state]) {
      panel.syncLastSavedTime(changes[namespace.STORAGE_KEYS.state].newValue);
      clearTimeout(storageSyncTimer);
      storageSyncTimer = setTimeout(() => {
        panel.syncFromStorage().catch((error) => console.warn("[AI 输入历史] 同步多窗口历史失败", error));
      }, 50);
    }
  });
  const sendDetector = new namespace.SendDetector(
    adapter,
    recordSend,
    (context) => requestTiming.capture(context.site),
    (context, metadata) => startRequestTiming(context, metadata),
    (tracking) => {
      if (tracking && requestTiming.active === tracking) requestTiming.finish("cancelled");
    }
  );

  document.addEventListener("focusin", handleFocus, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keydown", handleKeydown, true);
  document.addEventListener("submit", handleSubmit, true);
  document.addEventListener("pointerdown", handleSendControl, true);
  document.addEventListener("click", handleSendControl, true);
  window.addEventListener("scroll", () => panel.reposition(), true);
  window.addEventListener("resize", () => panel.reposition());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") recordSnapshot();
  });
  discoverComposer();

  function discoverComposer() {
    const candidate = adapter.findComposer(document, [panel.host, promptQueue?.shadow]);
    if (candidate) activate(candidate);
  }

  function handleFocus(event) {
    if (event.composedPath().includes(panel.host) || event.composedPath().includes(promptQueue?.host)) return;
    const candidate = adapter.resolveEventEditable(event);
    if (!adapter.isEditable(candidate) || adapter.composerScore(candidate) < 4) return;
    activate(candidate);
  }

  function activate(element) {
    const fieldKey = adapter.fieldKey(element);
    const changed = activeInput !== element || activeContext?.fieldKey !== fieldKey;
    if (changed) {
      clearTimeout(draftTimer);
      saveDraft();
      historyNavigator.reset();
      lastSnapshotText = "";
    }
    activeInput = element;
    if (changed) activeContext = {
      fieldKey,
      site: location.hostname,
      title: document.title.slice(0, 120),
      sessionId: makeSessionId()
    };
    panel.setTarget(element);
    if (changed || !snapshotTimer) scheduleSnapshots();
  }

  function handleInput(event) {
    if (event.composedPath().includes(panel.host) || event.composedPath().includes(promptQueue?.host)) return;
    if (!activeInput?.isConnected) handleFocus(event);
    if (adapter.resolveEventEditable(event) !== activeInput) return;
    if (historyNavigator.isApplying()) return;
    const currentText = adapter.getText(activeInput);
    if (!currentText.trim()) lastSnapshotText = "";
    // Queue 的填充/清空只改变编辑框内容，不应改变上下键历史游标。
    // 用户真实输入则以当前文本作为新的草稿起点，结束旧游标但绝不禁用历史导航。
    if (promptQueue?.mutatingComposer !== true) historyNavigator.reset();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 500);
    promptQueue?.scheduleDrain?.(120);
  }

  function saveDraft() {
    if (!activeInput || !activeContext) return;
    const context = activeContext;
    const text = adapter.getText(activeInput);
    return queueRecord(() => store.saveDraft(context.fieldKey, text, context));
  }

  async function recordSnapshot() {
    if (!activeInput?.isConnected || !activeContext || snapshotInFlight) return;
    const context = activeContext;
    const text = adapter.getText(activeInput);
    if (!text.trim() || text === lastSnapshotText) return;
    snapshotInFlight = true;
    return queueRecord(async () => {
      try {
        const entry = await store.addEntry(text, "snapshot", context);
        await store.saveDraft(context.fieldKey, text, context);
        if (activeContext === context) lastSnapshotText = text;
        panel.showSavedFeedback(entry?.createdAt);
      } finally {
        snapshotInFlight = false;
      }
    });
  }

  function timingSessionMessage(type, extra = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...extra }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) { reject(error); return; }
        if (!response?.ok) { reject(new Error(response?.error || "请求计时会话操作失败")); return; }
        resolve(response);
      });
    });
  }

  function notifyRequestCompleted(result) {
    promptQueue?.onRequestFinished?.(result);
    const enabled = liveSettings.completionNotification?.enabled === true;
    const eligible = result?.notificationEligible !== false;
    appendNotificationDebug("completion-detected", {
      enabled, notificationEligible: eligible,
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : null,
      detectionTrigger: result?.detectionTrigger || "unknown",
      visibility: document.visibilityState || "unknown",
      page: `${location.hostname}${location.pathname}`
    });
    if (!enabled || !eligible) return;
    try {
      chrome.runtime.sendMessage({ type: "AIH_REQUEST_COMPLETED", event: result, visibility: document.visibilityState || "unknown" }, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          console.warn("[AI 输入历史] 发送完成通知失败", error.message || error);
          return;
        }
        if (!response?.ok) console.warn("[AI 输入历史] 发送完成通知失败", response?.error || "后台通知失败");
      });
    } catch (error) {
      console.warn("[AI 输入历史] 发送完成通知失败", error);
    }
  }

  function appendNotificationDebug(stage, details = {}) {
    try {
      chrome.runtime.sendMessage({ type: "AIH_NOTIFICATION_DEBUG_APPEND", entry: { stage, ...details } }, () => {
        void chrome.runtime.lastError;
      });
    } catch {}
  }

  function startRequestTiming(context, metadata = {}) {
    if (!context) return null;
    const sentAt = Number.isFinite(metadata.sentAt) ? metadata.sentAt : Date.now();
    if (requestTiming.active && Math.abs(sentAt - requestTiming.active.startedAt) < 1500) return requestTiming.active;
    const captured = metadata.timing || requestTiming.capture(context.site);
    if (captured) captured.startedAt = sentAt;
    const sidebarStatus = sidebarTiming?.getStatusForPath(location.pathname);
    const sidebarEntryLoaded = sidebarTiming?.hasEntryForPath(location.pathname) === true;
    const tracking = requestTiming.start(context.site, captured, {
      promptText: metadata.promptText || "", pageUrl: location.href,
      // A missing sidebar row is NOT evidence that an old unread dot was cleared.
      sidebarUnreadAtStart: sidebarStatus === "completed" || !sidebarEntryLoaded,
      // Pro counting is handled by confirmed recordSend; a tentative timer
      // start (pointerdown or Enter) is not proof that a request was sent.
      countProUsage: false, proCountEnabledAtStart: liveSettings.trackProUsage === true
    });
    if (liveSettings.trackProUsage && tracking) {
      appendNotificationDebug("pro-model-sampled", {
        source: "content",
        reason: tracking.proModelId ? "pre-send-pro-confirmed" : "pre-send-pro-not-detected",
        model: tracking.proModelId || null,
        requestId: tracking.requestId, page: context.site
      });
    }
    promptQueue?.onRequestStarted?.();
    return tracking;
  }

  function writeProUsage(site, startedAt, modelId, requestId, evidence) {
    timingSessionMessage("AIH_PRO_USAGE_RECORD", {
      usage: { site, startedAt, proModelId: modelId, requestId }
    }).then((result) => {
      appendNotificationDebug(result?.counted ? "pro-usage-count-confirmed" : "pro-usage-not-counted", {
        source: "content", reason: result?.counted ? evidence : result?.reason || "duplicate-or-ineligible",
        model: modelId, requestId, page: site
      });
    }).catch((error) => appendNotificationDebug("pro-usage-not-counted", {
      source: "content", reason: "backend-count-error",
      model: modelId, requestId, page: site,
      error: String(error?.message || error).slice(0, 120)
    }));
  }

  function recordProUsageFromGeneration(request) {
    if (!liveSettings.trackProUsage || request?.completionContext?.proCountEnabledAtStart !== true)
      return true;
    if (request?.restored) return true;
    // React may mount the selected Pro pill only AFTER the send. A confirmed
    // assistant generation is a secondary count source; a click alone is not.
    const selected = [request.proModelId, namespace.proUsageModel?.detect()?.id]
      .find((id) => ["gpt-6-pro", "gpt-5.6-pro", "pro"].includes(id));
    if (!selected) {
      if (!request.proModelDiagnosticEmitted) {
        request.proModelDiagnosticEmitted = true;
        appendNotificationDebug("pro-usage-not-counted", {
          source: "content", reason: "generation-active-pro-model-not-detected",
          requestId: request.requestId, page: request.site,
          modelPickerCandidates: Math.min(99,
            document.querySelectorAll(namespace.proUsageModel.SELECTORS).length),
          composerEditorCandidates: Math.min(99,
            document.querySelectorAll(namespace.proUsageModel.COMPOSER_EDITOR_SELECTOR).length),
          composerActionCandidates: Math.min(99,
            document.querySelectorAll(namespace.proUsageModel.COMPOSER_ACTION_SELECTOR).length)
        });
      }
      return false; // Retry while generation is ongoing.
    }
    request.proModelId = selected;
    writeProUsage(request.site, request.startedAt, selected, request.requestId,
      "generation-confirmed");
    return true;
  }

  function recordProUsageSend(context, metadata, tracking) {
    if (!liveSettings.trackProUsage || !namespace.requestTimingModel?.isSupported(context.site)) return;
    // Capture the model *before* the send, since the picker can remount as soon
    // as generation starts. The post-send picker is only a fallback.
    const early = metadata.timing?.proModelId;
    const selected = [early, tracking?.proModelId, namespace.proUsageModel?.detect()?.id]
      .find((id) => ["gpt-6-pro", "gpt-5.6-pro", "pro"].includes(id));
    if (!selected) {
      appendNotificationDebug("pro-usage-not-counted", {
        source: "content", reason: "selected-pro-model-not-detected",
        page: context.site,
        modelPickerCandidates: Math.min(99, document.querySelectorAll(
          namespace.proUsageModel.SELECTORS
        ).length)
      });
      return;
    }
    const startedAt = Number.isFinite(metadata.sentAt) ? metadata.sentAt : Date.now();
    const requestId = metadata.requestHandle?.requestId || tracking?.requestId
      || `${context.site}:confirmed-pro-send:${startedAt}:${Math.random().toString(16).slice(2)}`;
    timingSessionMessage("AIH_PRO_USAGE_RECORD", {
      usage: { site: context.site, startedAt, proModelId: selected, requestId }
    }).then((result) => {
      appendNotificationDebug(result?.counted ? "pro-usage-count-confirmed" : "pro-usage-not-counted", {
        source: "content", reason: result?.counted ? "confirmed-send" : result?.reason || "duplicate-or-ineligible",
        model: selected, requestId, page: context.site
      });
    }).catch((error) => appendNotificationDebug("pro-usage-not-counted", {
      source: "content", reason: "backend-count-error",
      model: selected, requestId, page: context.site,
      error: String(error?.message || error).slice(0, 120)
    }));
  }

  async function recordSend(text, context, source, metadata = {}) {
    if (!text.trim()) return;
    clearTimeout(draftTimer);
    lastSnapshotText = text;
    recordSendStat(context, Number.isFinite(metadata.sentAt) ? metadata.sentAt : Date.now());
    if (activeContext === context) {
      historyNavigator.reset();
      activeContext = { ...context, sessionId: makeSessionId() };
    }
    const tracking = metadata.requestHandle?.requestId
      ? metadata.requestHandle : startRequestTiming(context, metadata);
    // Count a *confirmed* sent Pro request independently of timing activation.
    // Background request-ID deduplication prevents duplicate browser events.
    recordProUsageSend(context, metadata, tracking);
    promptQueue?.confirmRecordedSend?.(text).catch((error) => console.warn("[AI 输入历史] 确认排队发送失败", error));
    const sendContext = { ...context, sentAt: metadata.sentAt || Date.now(), trackRequestTime: liveSettings.trackRequestTime && Boolean(tracking) };
    return queueRecord(async () => {
      try {
        const entry = await store.addEntry(text, "send", sendContext);
        if (liveSettings.trackRequestTime) requestTiming.attach(tracking, entry?.id);
        await store.saveDraft(context.fieldKey, "", context);
        if (panel.isOpen()) await panel.refresh();
      } catch (error) {
        lastSnapshotText = "";
        // History storage failure does not mean ChatGPT generation failed.
        // Keep the active request timer alive so a real reply can finish it.
        if (requestTiming.active === tracking) {
          requestTiming.debug?.(tracking, "timing-history-write-failed", {
            source: "content", reason: "local-history-write-failed",
            error: String(error?.message || error).slice(0, 140)
          });
        }
        throw error;
      }
    });
  }

  function recordSendStat(context, sentAt) {
    const model = namespace.conversationStatsModel;
    if (!model || !context?.site || typeof store.recordSendStat !== "function") return;
    const aiKey = model.aiKeyForSite(context.site);
    store.recordSendStat({ aiKey, site: context.site, at: sentAt })
      .catch((error) => console.warn("[AI 输入历史] 保存 AI 发送统计失败", error));
  }

  function queueRecord(operation) {
    recordQueue = recordQueue.then(operation).catch((error) => {
      console.warn("[AI 输入历史] 保存输入历史失败", error);
    });
    return recordQueue;
  }

  function handleSubmit(event) {
    if (promptQueue?.interceptSubmit?.(event, activeInput)) return;
    sendDetector.handleSubmit(event, activeInput, activeContext);
  }

  function handleSendControl(event) {
    const path = event.composedPath();
    if (activeInput && path.includes(activeInput)) historyNavigator.interrupt();
    const stop = path.some((node) => node?.matches?.('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止生成"],form[data-chatgpt-composer] button[type="button"][aria-label="Stop"]'));
    if (stop && (event.button == null || event.button === 0)) {
      sendDetector.cancelEnter();
      requestTiming.finish("cancelled");
    }
    if (!stop && event.type === "click" && Number.isFinite(requestTiming.active?.pausedAt)
      && namespace.requestTimingModel?.isSelectionControl?.(event.target)) {
      requestTiming.selectionMade();
    }
    if (promptQueue?.interceptSendControl?.(event, activeInput)) return;
    if (promptQueue?.suppressAutoDispatchRecord?.()) return;
    sendDetector.handlePointerDown(event, activeInput, activeContext);
  }

  function handleHistoryArrowKeydown(event) {
    if (event.isComposing || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
    if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
    if (!activeInput || adapter.resolveEventEditable(event) !== activeInput) return;

    event.stopImmediatePropagation();
    const direction = event.key === "ArrowUp" ? "up" : "down";
    if (!historyNavigator.canMove() || adapter.canMoveVertically(activeInput, direction)) return;

    event.preventDefault();
    historyNavigator.move(direction, activeInput, activeContext).catch((error) => {
      console.warn("[AI 输入历史] 切换历史记录失败", error);
    });
  }

  async function handleKeydown(event) {
    if (event.isComposing) return;
    if (panel.isOpen() && handlePanelKeydown(event)) return;

    if (!activeInput || adapter.resolveEventEditable(event) !== activeInput) return;
    if (promptQueue?.interceptKeydown?.(event, activeInput)) return;
    if (namespace.historyModel.matchesShortcut(event, liveSettings.shortcut)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      await panel.open();
      return;
    }
    if (event.key === "Enter") {
      sendDetector.watchEnter(event, activeInput, activeContext);
      return;
    }
    if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)
      || (["ArrowUp", "ArrowDown"].includes(event.key) && (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey))) {
      historyNavigator.interrupt();
      return;
    }
  }

  function handlePanelKeydown(event) {
    if (panel.isClearConfirmationOpen()) {
      if (event.key === "Escape") {
        event.preventDefault();
        panel.closeClearConfirmation();
      }
      return true;
    }
    if (panel.isSiteFilterEvent(event)) return true;
    if (event.key === "Escape") {
      event.preventDefault();
      panel.close();
      activeInput?.focus();
      return true;
    }
    if (!event.composedPath().includes(panel.host)) return false;
    const target = panel.shadow.activeElement || event.target;
    const isSearch = target === panel.search;
    const isItem = target?.classList?.contains("item");
    if (!isSearch && !isItem) return true;
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      panel.moveSelection(event.key === "ArrowUp" ? -1 : 1);
    } else if (event.key === "Enter" && isSearch) {
      event.preventDefault();
      panel.choose();
    }
    return true;
  }

  function scheduleSnapshots() {
    clearInterval(snapshotTimer);
    snapshotTimer = setInterval(recordSnapshot, liveSettings.snapshotSeconds * 1_000);
  }

  function makeSessionId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {}).catch((error) => {
  console.warn("[AI 输入历史] 初始化失败", error);
});
