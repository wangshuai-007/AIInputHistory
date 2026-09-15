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
  let conversationStatsTimer = null;
  let conversationStatsFallbackSessionId = makeSessionId();
  let lastConversationStat = null;
  let promptQueue = null;

  window.addEventListener("keydown", handleHistoryArrowKeydown, true);

  const settings = await store.getSettings();
  namespace.i18n.setLanguage(settings.language);
  let liveSettings = settings;
  if (!namespace.SiteProfiles.isAllowedSite(location.hostname, settings.customDomains)) return;
  namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
  const queueSupported = namespace.promptQueueModel?.supportedSite(location.hostname) === true;

  const panel = new namespace.HistoryPanel(
    store,
    (text) => { if (activeInput) adapter.setText(activeInput, text); },
    () => historyNavigator.reset()
  );
  const timingSession = {
    save: (state) => timingSessionMessage("AIH_TIMING_SESSION_SAVE", { state }),
    load: async () => (await timingSessionMessage("AIH_TIMING_SESSION_LOAD", { site: location.hostname, path: location.pathname })).state,
    clear: (state) => timingSessionMessage("AIH_TIMING_SESSION_CLEAR", {
      requestId: state?.requestId || "", site: state?.site || location.hostname, path: state?.path || location.pathname
    })
  };
  const requestTiming = new namespace.RequestTiming({
    store,
    onTick: (elapsed) => panel.timingView.update(liveSettings.trackRequestTime ? elapsed : null),
    onComplete: notifyRequestCompleted,
    session: timingSession
  });
  panel.setStopTimingHandler?.(() => {
    if (!requestTiming.active) return;
    requestTiming.finish("cancelled");
    promptQueue?.onRequestFinished?.({ status: "cancelled", manual: true });
  });
  requestTiming.setEnabled(queueSupported || settings.trackRequestTime || settings.completionNotification?.enabled === true);
  await requestTiming.restore(location.hostname);
  if (queueSupported && typeof namespace.PromptQueue === "function") {
    promptQueue = new namespace.PromptQueue({
      store,
      adapter,
      getInput: () => activeInput?.isConnected ? activeInput : adapter.findComposer(document, [panel.host, promptQueue?.shadow]),
      isRequestActive: () => Boolean(requestTiming.active),
      getRequestStartedAt: () => requestTiming.active?.startedAt || 0
    });
    await promptQueue.init();
  }
  namespace.captureSiteIcon(store, location.hostname).then(async (dataUrl) => {
    if (!dataUrl) return;
    namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
    if (panel.isOpen()) await panel.loadSites();
  }).catch((error) => console.warn("[AI 输入历史] 读取网站图标失败", error));
  panel.setLauncherEnabled(settings.launcherEnabled);
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const nextSettings = changes[namespace.STORAGE_KEYS.settings]?.newValue;
    if (nextSettings) {
      liveSettings = namespace.historyModel.sanitizeSettings(nextSettings);
      requestTiming.setEnabled(queueSupported || liveSettings.trackRequestTime || liveSettings.completionNotification?.enabled === true);
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
    if (changes[namespace.STORAGE_KEYS.conversationStats]?.newValue) {
      const stats = namespace.conversationStatsModel?.sanitizeStats(changes[namespace.STORAGE_KEYS.conversationStats].newValue);
      if (stats && Object.keys(stats.byAi).length === 0) {
        lastConversationStat = null;
        conversationStatsFallbackSessionId = makeSessionId();
      }
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
    return requestTiming.start(context.site, captured, { promptText: metadata.promptText || "", pageUrl: location.href });
  }

  async function recordSend(text, context, source, metadata = {}) {
    if (!text.trim()) return;
    clearTimeout(draftTimer);
    lastSnapshotText = text;
    scheduleConversationStat(context, Number.isFinite(metadata.sentAt) ? metadata.sentAt : Date.now());
    if (activeContext === context) {
      historyNavigator.reset();
      activeContext = { ...context, sessionId: makeSessionId() };
    }
    const tracking = startRequestTiming(context, metadata);
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
        if (requestTiming.active === tracking) requestTiming.finish("failed");
        throw error;
      }
    });
  }

  function scheduleConversationStat(context, sentAt) {
    const model = namespace.conversationStatsModel;
    if (!model || typeof store.recordConversationStat !== "function" || window.top !== window) return;
    let immediate = model.resolveConversation(location, conversationStatsFallbackSessionId);
    if (!immediate.stable && lastConversationStat?.stable) {
      conversationStatsFallbackSessionId = makeSessionId();
      immediate = model.resolveConversation(location, conversationStatsFallbackSessionId);
    }
    clearTimeout(conversationStatsTimer);
    if (immediate.stable) {
      recordConversationStat(context, sentAt, immediate);
      return;
    }
    conversationStatsTimer = setTimeout(() => recordConversationStat(context, sentAt), 1500);
  }

  async function recordConversationStat(context, sentAt, resolvedOverride = null) {
    const model = namespace.conversationStatsModel;
    if (!model || !context?.site) return;
    const aiKey = model.aiKeyForSite(context.site);
    const resolved = resolvedOverride || model.resolveConversation(location, conversationStatsFallbackSessionId);
    if (lastConversationStat?.aiKey === aiKey && lastConversationStat.key === resolved.key) return;
    try {
      if (lastConversationStat?.aiKey === aiKey && lastConversationStat.stable === false && resolved.stable === true) {
        await store.markConversationStatSeen?.(aiKey, resolved.key, sentAt, lastConversationStat.key);
      } else {
        await store.recordConversationStat({ aiKey, site: context.site, conversationKey: resolved.key, at: sentAt });
      }
      lastConversationStat = { aiKey, key: resolved.key, stable: resolved.stable };
    } catch (error) {
      console.warn("[AI 输入历史] 保存 AI 对话统计失败", error);
    }
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
    const stop = path.some((node) => node?.matches?.('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止生成"]'));
    if (stop && (event.button == null || event.button === 0)) {
      sendDetector.cancelEnter();
      requestTiming.finish("cancelled");
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
