(async function startExtension(namespace) {
  "use strict";

  if (globalThis.__aiInputHistoryLoaded) return;
  globalThis.__aiInputHistoryLoaded = true;

  const store = new namespace.HistoryStore();
  const settings = await store.getSettings();
  namespace.i18n.setLanguage(settings.language);
  let liveSettings = settings;
  if (!namespace.SiteProfiles.isAllowedSite(location.hostname, settings.customDomains)) return;
  namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
  const adapter = namespace.InputAdapter;
  const historyNavigator = new namespace.HistoryNavigator(store, adapter);
  let activeInput = null;
  let activeContext = null;
  let draftTimer = null;
  let snapshotTimer = null;
  let lastSnapshotText = "";
  let storageSyncTimer = null;
  let snapshotInFlight = false;
  let recordQueue = Promise.resolve();

  const panel = new namespace.HistoryPanel(
    store,
    (text) => { if (activeInput) adapter.setText(activeInput, text); },
    () => historyNavigator.reset()
  );
  const requestTiming = new namespace.RequestTiming({
    store,
    onTick: (elapsed) => panel.timingView.update(liveSettings.trackRequestTime ? elapsed : null),
    onComplete: notifyRequestCompleted
  });
  requestTiming.setEnabled(settings.trackRequestTime || settings.completionNotification?.enabled === true);
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
      requestTiming.setEnabled(liveSettings.trackRequestTime || liveSettings.completionNotification?.enabled === true);
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
    (context, metadata) => startRequestTiming(context, metadata)
  );

  document.addEventListener("focusin", handleFocus, true);
  document.addEventListener("input", handleInput, true);
  document.addEventListener("keydown", handleKeydown, true);
  document.addEventListener("submit", handleSubmit, true);
  document.addEventListener("pointerdown", handleSendControl, true);
  document.addEventListener("click", handleSendControl, true);
  window.addEventListener("scroll", () => panel.reposition(), true);
  window.addEventListener("resize", () => panel.reposition());
  window.addEventListener("pagehide", () => requestTiming.finish("cancelled"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") recordSnapshot();
  });
  discoverComposer();

  function discoverComposer() {
    const candidate = adapter.findComposer(document, panel.host);
    if (candidate) activate(candidate);
  }

  function handleFocus(event) {
    if (event.composedPath().includes(panel.host)) return;
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
    if (event.composedPath().includes(panel.host)) return;
    if (!activeInput?.isConnected) handleFocus(event);
    if (adapter.resolveEventEditable(event) !== activeInput) return;
    if (historyNavigator.isApplying()) return;
    if (!adapter.getText(activeInput).trim()) lastSnapshotText = "";
    historyNavigator.reset();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 500);
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

  function notifyRequestCompleted(result) {
    if (liveSettings.completionNotification?.enabled !== true) return;
    try {
      chrome.runtime.sendMessage({ type: "AIH_REQUEST_COMPLETED", event: result }, () => void chrome.runtime.lastError);
    } catch (error) {
      console.warn("[AI 输入历史] 发送完成通知失败", error);
    }
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
    if (activeContext === context) {
      historyNavigator.reset();
      activeContext = { ...context, sessionId: makeSessionId() };
    }
    const tracking = startRequestTiming(context, metadata);
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

  function queueRecord(operation) {
    recordQueue = recordQueue.then(operation).catch((error) => {
      console.warn("[AI 输入历史] 保存输入历史失败", error);
    });
    return recordQueue;
  }

  function handleSubmit(event) {
    sendDetector.handleSubmit(event, activeInput, activeContext);
  }

  function handleSendControl(event) {
    const stop = event.composedPath().some((node) => node?.matches?.('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止生成"]'));
    if (stop && (event.button == null || event.button === 0)) {
      sendDetector.cancelEnter();
      requestTiming.finish("cancelled");
    }
    sendDetector.handlePointerDown(event, activeInput, activeContext);
  }

  async function handleKeydown(event) {
    if (event.isComposing) return;
    if (panel.isOpen() && handlePanelKeydown(event)) return;

    if (!activeInput || adapter.resolveEventEditable(event) !== activeInput) return;
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
    if (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? "up" : "down";
      await historyNavigator.move(direction, activeInput, activeContext);
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
