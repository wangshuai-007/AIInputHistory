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
  namespace.captureSiteIcon(store, location.hostname).then(async (dataUrl) => {
    if (!dataUrl) return;
    namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
    if (panel.isOpen()) panel.loadSites();
  });
  const adapter = namespace.InputAdapter;
  const historyNavigator = new namespace.HistoryNavigator(store, adapter);
  let activeInput = null;
  let activeContext = null;
  let draftTimer = null;
  let snapshotTimer = null;
  let lastSnapshotText = "";
  let storageSyncTimer = null;

  const panel = new namespace.HistoryPanel(
    store,
    (text) => { if (activeInput) adapter.setText(activeInput, text); },
    () => historyNavigator.reset()
  );
  panel.setLauncherEnabled(settings.launcherEnabled);
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const nextSettings = changes[namespace.STORAGE_KEYS.settings]?.newValue;
    if (nextSettings) {
      liveSettings = namespace.historyModel.sanitizeSettings(nextSettings);
      panel.setLauncherEnabled(nextSettings.launcherEnabled !== false);
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
  const sendDetector = new namespace.SendDetector(adapter, recordSend);

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

  function handleFocus(event) {
    const candidate = adapter.resolveEventEditable(event);
    if (!adapter.isEditable(candidate) || adapter.composerScore(candidate) < 4) return;
    activate(candidate);
  }

  function activate(element) {
    if (activeInput !== element) historyNavigator.reset();
    const sessionId = activeInput === element && activeContext?.sessionId ? activeContext.sessionId : makeSessionId();
    activeInput = element;
    activeContext = {
      fieldKey: adapter.fieldKey(element),
      site: location.hostname,
      title: document.title.slice(0, 120),
      sessionId
    };
    panel.setTarget(element);
    scheduleSnapshots();
  }

  function handleInput(event) {
    if (adapter.resolveEventEditable(event) !== activeInput) return;
    if (historyNavigator.isApplying()) return;
    if (!adapter.getText(activeInput).trim()) lastSnapshotText = "";
    historyNavigator.reset();
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 500);
  }

  async function saveDraft() {
    if (!activeInput || !activeContext) return;
    try {
      await store.saveDraft(activeContext.fieldKey, adapter.getText(activeInput), activeContext);
    } catch (error) {
      console.warn("[AI 输入历史] 保存草稿失败", error);
    }
  }

  async function recordSnapshot() {
    if (!activeInput || !activeContext) return;
    const text = adapter.getText(activeInput);
    if (!text.trim() || text === lastSnapshotText) return;
    try {
      const entry = await store.addEntry(text, "snapshot", activeContext);
      await store.saveDraft(activeContext.fieldKey, text, activeContext);
      lastSnapshotText = text;
      panel.showSavedFeedback(entry?.createdAt);
    } catch (error) {
      console.warn("[AI 输入历史] 记录快照失败", error);
    }
  }

  async function recordSend(text, context) {
    if (!text.trim()) return;
    clearTimeout(draftTimer);
    lastSnapshotText = text;
    try {
      await store.addEntry(text, "send", context);
      await store.saveDraft(context.fieldKey, "", context);
      historyNavigator.reset();
      if (activeContext === context) activeContext = { ...context, sessionId: makeSessionId() };
      if (panel.isOpen()) await panel.refresh();
    } catch (error) {
      lastSnapshotText = "";
      console.warn("[AI 输入历史] 记录发送内容失败", error);
    }
  }

  function handleSubmit(event) {
    sendDetector.handleSubmit(event, activeInput, activeContext);
  }

  function handleSendControl(event) {
    sendDetector.handlePointerDown(event, activeInput, activeContext);
  }

  async function handleKeydown(event) {
    if (event.isComposing) return;
    if (panel.isOpen()) {
      if (event.key === "Escape" && panel.isClearConfirmationOpen()) {
        event.preventDefault();
        panel.closeClearConfirmation();
        return;
      }
      const siteFilterEvent = panel.isSiteFilterEvent(event);
      if (!siteFilterEvent && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault();
        panel.moveSelection(event.key === "ArrowUp" ? -1 : 1);
        return;
      }
      if (!siteFilterEvent && event.key === "Enter" && adapter.resolveEventEditable(event) !== activeInput) {
        event.preventDefault();
        panel.choose();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        panel.close();
        activeInput?.focus();
        return;
      }
    }

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

  async function scheduleSnapshots() {
    clearInterval(snapshotTimer);
    const settings = await store.getSettings();
    snapshotTimer = setInterval(recordSnapshot, settings.snapshotSeconds * 1_000);
  }

  function makeSessionId() {
    return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {}).catch((error) => {
  console.warn("[AI 输入历史] 初始化失败", error);
});
