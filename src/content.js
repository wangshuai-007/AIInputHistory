(async function startExtension(namespace) {
  "use strict";

  if (globalThis.__aiInputHistoryLoaded) return;
  globalThis.__aiInputHistoryLoaded = true;

  const store = new namespace.HistoryStore();
  const settings = await store.getSettings();
  if (!namespace.SiteProfiles.isAllowedSite(location.hostname, settings.customDomains)) return;
  namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
  namespace.captureSiteIcon(store, location.hostname).then(async (dataUrl) => {
    if (!dataUrl) return;
    namespace.SiteProfiles.setSiteIcons(await store.getSiteIcons());
    if (panel.isOpen()) panel.loadSites();
  });
  const adapter = namespace.InputAdapter;
  let activeInput = null;
  let activeContext = null;
  let draftTimer = null;
  let snapshotTimer = null;
  let lastSnapshotText = "";
  let navigationEntries = [];
  let navigationIndex = -1;
  let navigationOriginal = "";
  let storageSyncTimer = null;

  const panel = new namespace.HistoryPanel(
    store,
    (text) => { if (activeInput) adapter.setText(activeInput, text); },
    () => {
      navigationEntries = [];
      navigationIndex = -1;
    }
  );
  panel.setLauncherEnabled(settings.launcherEnabled);
  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const nextSettings = changes[namespace.STORAGE_KEYS.settings]?.newValue;
    if (nextSettings) {
      panel.setLauncherEnabled(nextSettings.launcherEnabled !== false);
      if (changes[namespace.STORAGE_KEYS.settings]?.oldValue?.snapshotSeconds !== nextSettings.snapshotSeconds) scheduleSnapshots();
    }
    if (changes[namespace.STORAGE_KEYS.state]) {
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
    activeInput = element;
    activeContext = {
      fieldKey: adapter.fieldKey(element),
      site: location.hostname,
      title: document.title.slice(0, 120)
    };
    navigationEntries = [];
    navigationIndex = -1;
    panel.setTarget(element);
    scheduleSnapshots();
  }

  function handleInput(event) {
    if (adapter.resolveEventEditable(event) !== activeInput) return;
    if (!adapter.getText(activeInput).trim()) lastSnapshotText = "";
    navigationIndex = -1;
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
      await store.addEntry(text, "snapshot", activeContext);
      await store.saveDraft(activeContext.fieldKey, text, activeContext);
      lastSnapshotText = text;
      panel.showSavedFeedback();
    } catch (error) {
      console.warn("[AI 输入历史] 记录快照失败", error);
    }
  }

  async function recordSend(text, context) {
    if (!text.trim()) return;
    try {
      await store.addEntry(text, "send", context);
      await store.saveDraft(context.fieldKey, "", context);
      navigationEntries = [];
      navigationIndex = -1;
      if (panel.isOpen()) await panel.refresh();
    } catch (error) {
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
    if (event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLocaleLowerCase() === "r") {
      event.preventDefault();
      event.stopImmediatePropagation();
      await panel.open();
      return;
    }
    if (event.key === "Enter") {
      sendDetector.watchEnter(event, activeInput, activeContext);
      return;
    }
    if (!event.ctrlKey && !event.altKey && !event.metaKey && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      const direction = event.key === "ArrowUp" ? "up" : "down";
      if (adapter.shouldNavigateHistory(activeInput, direction)) {
        const switched = await navigateHistory(direction);
        if (switched) event.preventDefault();
      }
    }
  }

  async function navigateHistory(direction) {
    if (!navigationEntries.length) {
      navigationEntries = await store.getHistory("", false, activeContext.site);
      navigationOriginal = adapter.getText(activeInput);
    }
    if (!navigationEntries.length) return false;
    if (direction === "up") {
      navigationIndex = Math.min(navigationEntries.length - 1, navigationIndex + 1);
      adapter.setText(activeInput, navigationEntries[navigationIndex].text);
      return true;
    }
    if (navigationIndex <= 0) {
      navigationIndex = -1;
      adapter.setText(activeInput, navigationOriginal);
      return true;
    }
    navigationIndex -= 1;
    adapter.setText(activeInput, navigationEntries[navigationIndex].text);
    return true;
  }

  async function scheduleSnapshots() {
    clearInterval(snapshotTimer);
    const settings = await store.getSettings();
    snapshotTimer = setInterval(recordSnapshot, settings.snapshotSeconds * 1_000);
  }
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {}).catch((error) => {
  console.warn("[AI 输入历史] 初始化失败", error);
});
