(async function initializePopup(namespace) {
  "use strict";

  const store = new namespace.HistoryStore();
  const numericFields = ["historyLimit", "sendLimit", "snapshotSeconds"];
  const status = document.querySelector("#status");
  const launcherToggle = document.querySelector("#launcherEnabled");
  const timingToggle = document.querySelector("#trackRequestTime");
  const proUsageToggle = document.querySelector("#trackProUsage");
  const proPlanSelect = document.querySelector("#proPlan");
  const detectProPlanButton = document.querySelector("#detectProPlan");
  const proPlanDetection = document.querySelector("#proPlanDetection");
  const proUsageSection = document.querySelector("#proUsageSection");
  const proUsageSettings = document.querySelector("#proUsageSettings");
  const notifyToggle = document.querySelector("#notifyEnabled");
  const notifyProvider = document.querySelector("#notifyProvider");
  const testNotificationButton = document.querySelector("#testNotification");
  const notifyAvailableTimesList = document.querySelector("#notifyAvailableTimes");
  const addNotifyAvailableTimeButton = document.querySelector("#addNotifyAvailableTime");
  const notificationDebugLog = document.querySelector("#notificationDebugLog");
  const refreshNotificationDebugButton = document.querySelector("#refreshNotificationDebug");
  const copyNotificationDebugButton = document.querySelector("#copyNotificationDebug");
  const exportNotificationDebugButton = document.querySelector("#exportNotificationDebug");
  const notificationDebugFilter = document.querySelector("#notificationDebugFilter");
  const clearNotificationDebugButton = document.querySelector("#clearNotificationDebug");
  let cachedDiagnosticData = { logs: [], activeSessions: [] };
  let proUsagePeriod = "day";
  const notificationInputs = {
    minDurationSeconds: "#notifyMinDurationSeconds",
    barkUrl: "#notifyBarkUrl", serverChanKey: "#notifyServerChanKey", pushPlusToken: "#notifyPushPlusToken",
    ntfyUrl: "#notifyNtfyUrl", ntfyTopic: "#notifyNtfyTopic", gotifyUrl: "#notifyGotifyUrl", gotifyToken: "#notifyGotifyToken",
    dingtalkWebhook: "#notifyDingtalkWebhook", feishuWebhook: "#notifyFeishuWebhook", wecomWebhook: "#notifyWecomWebhook",
    customMethod: "#notifyCustomMethod", customUrl: "#notifyCustomUrl", customHeaders: "#notifyCustomHeaders", customBody: "#notifyCustomBody"
  };
  const domainInput = document.querySelector("#domainInput");
  const domainList = document.querySelector("#domainList");
  const shortcutCapture = document.querySelector("#shortcutCapture");
  const shortcutDisable = document.querySelector("#shortcutDisable");
  const languageSelect = document.querySelector("#languageSelect");
  const clearDialog = document.querySelector("#clearDialog");
  const clearDialogError = document.querySelector("#clearDialogError");
  const clearConversationStatsButton = document.querySelector("#clearConversationStats");
  const conversationStatsList = document.querySelector("#conversationStatsList");
  let [settings, state, conversationStats, proUsageStats, proQuotaStatus] = await Promise.all([
    store.getSettings(), store.getState(), store.getSendStats(), store.getProUsageStats(),
    store.getProQuotaStatus()
  ]);
  namespace.i18n.setLanguage(settings.language);
  proPlanDetection.textContent = namespace.i18n.t("proUsage.detectHint");
  let saveQueue = Promise.resolve();
  let requestedProUsage = settings.trackProUsage === true;
  let proUsageChangeId = 0;
  let proUsageSavesPending = 0;
  let proPlanEditId = 0;
  let planLookupId = 0;
  let planLookupTask = null;
  let statusTimer = null;
  let capturingShortcut = false;
  document.querySelector("#extensionVersion").textContent = `v${chrome.runtime.getManifest().version}`;

  numericFields.forEach((name) => {
    const input = document.querySelector(`#${name}`);
    input.value = settings[name];
    input.addEventListener("input", () => {
      if (input.value !== "" && input.validity.valid) persistSettings({ [name]: input.value }, namespace.i18n.t("status.saved"), false);
    });
    input.addEventListener("change", () => persistSettings({ [name]: input.value }, namespace.i18n.t("status.saved")));
  });
  launcherToggle.checked = settings.launcherEnabled;
  timingToggle.checked = settings.trackRequestTime;
  timingToggle.addEventListener("change", () => persistSettings({ trackRequestTime: timingToggle.checked }, namespace.i18n.t("status.saved")));
  proUsageToggle.checked = settings.trackProUsage === true;
  proUsageToggle.addEventListener("change", async () => {
    const enabled = proUsageToggle.checked === true;
    if (enabled === requestedProUsage) return;
    const shouldReadPlan = enabled && !requestedProUsage;
    requestedProUsage = enabled;
    const changeId = ++proUsageChangeId;
    proUsageSection.hidden = !enabled;
    proUsageSettings.hidden = !enabled;
    proUsageSavesPending += 1;
    let saved;
    try {
      saved = await persistSettings({ trackProUsage: enabled }, namespace.i18n.t("status.saved"));
    } finally {
      proUsageSavesPending -= 1;
    }
    if (!saved) {
      if (changeId === proUsageChangeId) {
        requestedProUsage = settings.trackProUsage === true;
        proUsageToggle.checked = requestedProUsage;
        proUsageSection.hidden = !requestedProUsage;
        proUsageSettings.hidden = !requestedProUsage;
      }
      return;
    }
    // Only this explicit off -> on action triggers a read. Opening the popup,
    // storage sync and other settings do not query the account again.
    if (shouldReadPlan && changeId === proUsageChangeId && requestedProUsage
      && settings.trackProUsage === true) {
      await detectCurrentAccountPlan({ automatic: true });
    }
  });
  proPlanSelect.value = settings.proPlan || "unknown";
  proPlanSelect.addEventListener("change", async () => {
    const plan = proPlanSelect.value;
    proPlanEditId += 1;
    // A manual edit made while reading wins over any delayed lookup result.
    proPlanDetection.textContent = namespace.i18n.t("proUsage.planManual");
    await persistSettings({ proPlan: plan }, namespace.i18n.t("status.saved"));
  });
  detectProPlanButton.addEventListener("click", () => detectCurrentAccountPlan());
  renderNotificationSettings();
  notifyToggle.addEventListener("change", changeNotificationEnabled);
  notifyProvider.addEventListener("change", changeNotificationProvider);
  Object.values(notificationInputs).forEach((selector) => document.querySelector(selector).addEventListener("change", saveNotificationConfig));
  addNotifyAvailableTimeButton.addEventListener("click", addNotificationTimeRange);
  notifyAvailableTimesList.addEventListener("change", saveNotificationConfig);
  notifyAvailableTimesList.addEventListener("click", removeNotificationTimeRange);
  testNotificationButton.addEventListener("click", testNotification);
  refreshNotificationDebugButton.addEventListener("click", loadNotificationDebugLog);
  copyNotificationDebugButton.addEventListener("click", copyNotificationDebugLog);
  exportNotificationDebugButton.addEventListener("click", exportNotificationDebugLog);
  notificationDebugFilter.addEventListener("input", renderNotificationDebugLog);
  clearNotificationDebugButton.addEventListener("click", clearNotificationDebugLog);
  launcherToggle.addEventListener("change", () => persistSettings(
    { launcherEnabled: launcherToggle.checked },
    namespace.i18n.t(launcherToggle.checked ? "status.launcherOn" : "status.launcherOff")
  ));
  languageSelect.addEventListener("change", changeLanguage);
  document.querySelector("#domainForm").addEventListener("submit", addDomain);
  document.querySelector("#clear").addEventListener("click", openClearConfirmation);
  clearConversationStatsButton.addEventListener("click", clearConversationStats);
  document.querySelector("#resetProUsage").addEventListener("click", resetLocalProUsage);
  document.querySelector("#proUsagePeriods").addEventListener("click", (event) => {
    const period = event.target.closest?.("button[data-pro-period]")?.dataset?.proPeriod;
    if (!["day", "week", "month"].includes(period)) return;
    proUsagePeriod = period;
    renderProUsage();
  });
  document.querySelector("#cancelClear").addEventListener("click", closeClearConfirmation);
  document.querySelector("#confirmClear").addEventListener("click", clearHistory);
  clearDialog.addEventListener("cancel", () => { clearDialogError.textContent = ""; });
  shortcutCapture.addEventListener("click", startShortcutCapture);
  shortcutCapture.addEventListener("keydown", captureShortcut);
  shortcutDisable.addEventListener("click", disableShortcut);
  renderStats(state);
  applyLanguage();
  loadNotificationDebugLog();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[namespace.STORAGE_KEYS.state]?.newValue) renderStats(changes[namespace.STORAGE_KEYS.state].newValue);
    if (changes[namespace.STORAGE_KEYS.sendStats]?.newValue) {
      conversationStats = namespace.conversationStatsModel.summarize(changes[namespace.STORAGE_KEYS.sendStats].newValue);
      renderConversationStats();
    }
    if (changes[namespace.STORAGE_KEYS.proUsage]?.newValue) {
      proUsageStats = namespace.proUsageModel.summarize(changes[namespace.STORAGE_KEYS.proUsage].newValue);
      renderProUsage();
    }
    if (changes[namespace.STORAGE_KEYS.proQuota]) {
      proQuotaStatus = Object.fromEntries(Object.entries(changes[namespace.STORAGE_KEYS.proQuota].newValue || {})
        .filter(([, status]) => namespace.proQuotaModel?.activeStatus(status)));
      renderProQuota();
    }
    const next = changes[namespace.STORAGE_KEYS.settings]?.newValue;
    if (!next) return;
    if ((next.proPlan || "unknown") !== (settings.proPlan || "unknown")) proPlanEditId += 1;
    if (proUsageSavesPending === 0 && (next.trackProUsage === true) !== (settings.trackProUsage === true)) {
      requestedProUsage = next.trackProUsage === true;
      proUsageChangeId += 1;
    }
    settings = namespace.historyModel.sanitizeSettings(next);
    launcherToggle.checked = settings.launcherEnabled;
    timingToggle.checked = settings.trackRequestTime;
    proUsageToggle.checked = settings.trackProUsage === true;
    proPlanSelect.value = settings.proPlan || "unknown";
    proUsageSection.hidden = settings.trackProUsage !== true;
    proUsageSettings.hidden = settings.trackProUsage !== true;
    renderNotificationSettings();
    numericFields.forEach((name) => {
      const input = document.querySelector(`#${name}`);
      if (document.activeElement !== input) input.value = settings[name];
    });
    namespace.i18n.setLanguage(settings.language);
    applyLanguage();
  });

  function persistSettings(patch, message, normalizeInputs = true) {
    saveQueue = saveQueue.then(async () => {
      try {
        settings = await store.patchSettings(patch);
        if (normalizeInputs) numericFields.forEach((name) => { document.querySelector(`#${name}`).value = settings[name]; });
        launcherToggle.checked = settings.launcherEnabled;
        timingToggle.checked = settings.trackRequestTime;
        proUsageToggle.checked = settings.trackProUsage === true;
        proPlanSelect.value = settings.proPlan || "unknown";
        proUsageSection.hidden = settings.trackProUsage !== true;
        proUsageSettings.hidden = settings.trackProUsage !== true;
        renderNotificationSettings();
        if (patch.language) namespace.i18n.setLanguage(settings.language);
        applyLanguage();
        showStatus(message);
        return true;
      } catch (error) {
        showStatus(namespace.i18n.t("status.saveFailed"), true);
        console.error(error);
        return false;
      }
    });
    return saveQueue;
  }

  function changeLanguage() {
    namespace.i18n.setLanguage(languageSelect.value);
    applyLanguage();
    persistSettings({ language: languageSelect.value }, namespace.i18n.t("status.saved"));
  }

  function applyLanguage() {
    document.documentElement.lang = namespace.i18n.language();
    namespace.i18n.localize(document);
    languageSelect.value = namespace.i18n.language();
    renderDomains();
    renderConversationStats();
    renderProUsage();
    renderProQuota();
    proUsageSection.hidden = settings.trackProUsage !== true;
    proUsageSettings.hidden = settings.trackProUsage !== true;
    renderAvailableTimes(settings.completionNotification?.availableTimes || []);
    if (!capturingShortcut) renderShortcut(settings.shortcut);
  }

  function collectNotificationConfig(overrides = {}) {
    const current = settings.completionNotification || {};
    const value = (name) => document.querySelector(notificationInputs[name]).value;
    return {
      ...current, enabled: notifyToggle.checked, provider: notifyProvider.value,
      minDurationSeconds: value("minDurationSeconds"),
      availableTimes: collectAvailableTimes(),
      barkUrl: value("barkUrl"), serverChanKey: value("serverChanKey"), pushPlusToken: value("pushPlusToken"),
      ntfyUrl: value("ntfyUrl"), ntfyTopic: value("ntfyTopic"), gotifyUrl: value("gotifyUrl"), gotifyToken: value("gotifyToken"),
      dingtalkWebhook: value("dingtalkWebhook"), feishuWebhook: value("feishuWebhook"), wecomWebhook: value("wecomWebhook"),
      customMethod: value("customMethod"), customUrl: value("customUrl"), customHeaders: value("customHeaders"), customBody: value("customBody"),
      ...overrides
    };
  }

  function collectAvailableTimes() {
    const rows = [...(notifyAvailableTimesList.querySelectorAll?.(".notify-time-row") || [])];
    return rows.map((row) => ({
      start: row.querySelector("[data-notify-time-start]")?.value || "",
      end: row.querySelector("[data-notify-time-end]")?.value || ""
    })).filter((range) => range.start && range.end);
  }

  function renderAvailableTimes(ranges) {
    const normalized = namespace.historyModel.sanitizeAvailableTimes?.(ranges) || [];
    notifyAvailableTimesList.innerHTML = "";
    if (!normalized.length) {
      const empty = document.createElement("div");
      empty.className = "notify-time-empty";
      empty.textContent = namespace.i18n.t("notify.allDay");
      notifyAvailableTimesList.appendChild(empty);
    } else {
      normalized.forEach((range) => {
        const row = document.createElement("div");
        row.className = "notify-time-row";
        row.innerHTML = `<input type="time" data-notify-time-start value="${range.start}"><span>–</span><input type="time" data-notify-time-end value="${range.end}"><button type="button" data-notify-time-remove aria-label="${namespace.i18n.t("notify.removeTime")}">×</button>`;
        notifyAvailableTimesList.appendChild(row);
      });
    }
    const enabled = notifyToggle.checked;
    notifyAvailableTimesList.querySelectorAll?.("input,button").forEach((control) => { control.disabled = !enabled; });
    addNotifyAvailableTimeButton.disabled = !enabled || normalized.length >= 12;
  }

  function addNotificationTimeRange() {
    const current = collectAvailableTimes();
    if (current.length >= 12) return;
    renderAvailableTimes([...current, { start: "09:00", end: "18:00" }]);
    saveNotificationConfig();
  }

  function removeNotificationTimeRange(event) {
    const button = event.target?.closest?.("[data-notify-time-remove]");
    if (!button) return;
    button.closest(".notify-time-row")?.remove();
    saveNotificationConfig();
  }

  function renderNotificationSettings() {
    const config = settings.completionNotification || { enabled: false, provider: "browser" };
    notifyToggle.checked = config.enabled === true;
    notifyProvider.value = config.provider || "browser";
    Object.entries(notificationInputs).forEach(([name, selector]) => { document.querySelector(selector).value = config[name] ?? ""; });
    renderAvailableTimes(config.availableTimes || []);
    setNotificationControlsEnabled(config.enabled === true);
    document.querySelectorAll("[data-notify-provider]").forEach((section) => {
      const active = section.dataset.notifyProvider === notifyProvider.value;
      active ? section.classList.add("active") : section.classList.remove("active");
    });
  }

  function setNotificationControlsEnabled(enabled) {
    notifyProvider.disabled = !enabled;
    testNotificationButton.disabled = !enabled;
    addNotifyAvailableTimeButton.disabled = !enabled || collectAvailableTimes().length >= 12;
    Object.values(notificationInputs).forEach((selector) => { document.querySelector(selector).disabled = !enabled; });
    notifyAvailableTimesList.querySelectorAll?.("input,button").forEach((control) => { control.disabled = !enabled; });
  }

  function renderNotificationSettingsPreview() {
    document.querySelectorAll("[data-notify-provider]").forEach((section) => {
      const active = section.dataset.notifyProvider === notifyProvider.value;
      active ? section.classList.add("active") : section.classList.remove("active");
    });
  }

  function requestPermission(request) {
    return new Promise((resolve, reject) => {
      if (!chrome.permissions?.request) { reject(new Error(namespace.i18n.t("notify.permissionUnavailable"))); return; }
      chrome.permissions.request(request, (granted) => {
        const error = chrome.runtime.lastError;
        if (error) reject(error);
        else granted ? resolve(true) : reject(new Error(namespace.i18n.t("notify.permissionDenied")));
      });
    });
  }

  async function ensureNotificationPermission(config) {
    if (config.provider === "browser") return requestPermission({ permissions: ["notifications"] });
    const origin = namespace.notificationModel.requiredOrigin(config);
    if (!origin) throw new Error(namespace.i18n.t("notify.invalidConfig"));
    return requestPermission({ origins: [origin] });
  }

  async function changeNotificationEnabled() {
    const config = collectNotificationConfig();
    if (config.enabled) {
      try { await ensureNotificationPermission(config); }
      catch (error) {
        notifyToggle.checked = false;
        showStatus(error.message || namespace.i18n.t("notify.permissionDenied"), true);
        return;
      }
    }
    await persistSettings({ completionNotification: { ...config, enabled: notifyToggle.checked } }, namespace.i18n.t("status.saved"));
  }

  async function changeNotificationProvider() {
    renderNotificationSettingsPreview();
    const config = collectNotificationConfig();
    if (config.enabled) {
      try { await ensureNotificationPermission(config); }
      catch (error) {
        notifyProvider.value = settings.completionNotification?.provider || "browser";
        renderNotificationSettingsPreview();
        showStatus(error.message || namespace.i18n.t("notify.permissionDenied"), true);
        return;
      }
    }
    await persistSettings({ completionNotification: config }, namespace.i18n.t("status.saved"));
  }

  function saveNotificationConfig() {
    return persistSettings({ completionNotification: collectNotificationConfig() }, namespace.i18n.t("status.saved"));
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      error ? reject(error) : resolve(response);
    }));
  }

  function formatNotificationDebugLog(logs, sessions = [], query = "") {
    const match = (entry) => !query || [entry.conversationId, entry.requestId, entry.site]
      .some((value) => String(value || "").toLowerCase().includes(query));
    const visibleSessions = (Array.isArray(sessions) ? sessions : []).filter(match);
    const visibleLogs = (Array.isArray(logs) ? logs : []).filter(match);
    const active = visibleSessions.map((state) => {
      const elapsed = Number.isFinite(state.elapsedMs) ? (state.elapsedMs / 1000).toFixed(1) : "?";
      const since = Number.isFinite(state.pausedDurationMs) ? (state.pausedDurationMs / 1000).toFixed(1) : "0";
      return `${state.status}  ${state.site || ""}  conversationId=${state.conversationId || "pending"}  requestId=${state.requestId || ""}\n  elapsed=${elapsed}s pausedTotal=${since}s pausedAt=${state.pausedAt || "-"}`;
    });
    const events = visibleLogs.slice().reverse().map((entry) => {
      const time = Number.isFinite(entry.at) ? new Date(entry.at).toLocaleString(namespace.i18n.locale()) : "?";
      const details = Object.entries(entry)
        .filter(([key]) => !["at", "traceId", "stage"].includes(key))
        .map(([key, value]) => `${key}=${value}`).join(" ");
      return `${time}  ${entry.stage || "event"}${entry.traceId ? `  #${String(entry.traceId).slice(-8)}` : ""}${details ? `\n  ${details}` : ""}`;
    });
    return [
      `[${namespace.i18n.t("notify.debugSessions")}]`,
      active.join("\n") || namespace.i18n.t("notify.debugNoSessions"),
      "",
      `[${namespace.i18n.t("notify.debugEvents")}: ${events.length}]`,
      events.join("\n") || namespace.i18n.t(query ? "notify.debugNoMatches" : "notify.debugEmpty")
    ].join("\n");
  }

  function renderNotificationDebugLog() {
    notificationDebugLog.textContent = formatNotificationDebugLog(
      cachedDiagnosticData.logs, cachedDiagnosticData.activeSessions,
      String(notificationDebugFilter.value || "").trim().toLowerCase()
    );
  }

  async function loadNotificationDebugLog() {
    try {
      const result = await runtimeMessage({ type: "AIH_NOTIFICATION_DEBUG_GET" });
      if (!result?.ok) throw new Error(result?.error || "debug log unavailable");
      cachedDiagnosticData = {
        logs: Array.isArray(result.logs) ? result.logs : [],
        activeSessions: Array.isArray(result.activeSessions) ? result.activeSessions : []
      };
      renderNotificationDebugLog();
    } catch (error) {
      notificationDebugLog.textContent = error?.message || String(error);
    }
  }

  async function copyNotificationDebugLog() {
    try {
      await loadNotificationDebugLog();
      await navigator.clipboard.writeText(notificationDebugLog.textContent || "");
      showStatus(namespace.i18n.t("notify.debugCopied"));
    } catch (error) {
      showStatus(error?.message || namespace.i18n.t("status.saveFailed"), true);
    }
  }

  async function exportNotificationDebugLog() {
    try {
      const result = await runtimeMessage({ type: "AIH_NOTIFICATION_DEBUG_GET" });
      if (!result?.ok) throw new Error(result?.error || "diagnostic export unavailable");
      const payload = {
        format: "AIInputHistory-Diagnostics-v1",
        exportedAt: new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
        activeSessions: Array.isArray(result.activeSessions) ? result.activeSessions : [],
        logs: Array.isArray(result.logs) ? result.logs : []
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `AIInputHistory-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showStatus(namespace.i18n.t("notify.debugExported"));
    } catch (error) {
      showStatus(error?.message || namespace.i18n.t("status.saveFailed"), true);
    }
  }

  async function clearNotificationDebugLog() {
    try {
      const result = await runtimeMessage({ type: "AIH_NOTIFICATION_DEBUG_CLEAR" });
      if (!result?.ok) throw new Error(result?.error || "debug log clear failed");
      cachedDiagnosticData.logs = [];
      renderNotificationDebugLog();
      showStatus(namespace.i18n.t("notify.debugCleared"));
    } catch (error) {
      showStatus(error?.message || namespace.i18n.t("status.saveFailed"), true);
    }
  }

  async function testNotification() {
    if (!notifyToggle.checked) return;
    testNotificationButton.disabled = true;
    try {
      const config = collectNotificationConfig();
      await ensureNotificationPermission(config);
      await persistSettings({ completionNotification: config }, namespace.i18n.t("status.saved"));
      const result = await runtimeMessage({ type: "AIH_NOTIFICATION_TEST" });
      if (!result?.ok) throw new Error(result?.error || namespace.i18n.t("notify.testFailed"));
      showStatus(namespace.i18n.t("notify.testSent"));
    } catch (error) {
      showStatus(error.message || namespace.i18n.t("notify.testFailed"), true);
    } finally {
      setNotificationControlsEnabled(notifyToggle.checked);
    }
  }

  async function addDomain(event) {
    event.preventDefault();
    const domain = namespace.historyModel.normalizeDomain(domainInput.value);
    if (!domain) {
      showStatus(namespace.i18n.t("domains.invalid"), true);
      return;
    }
    if (namespace.SiteProfiles.forSite(domain)) {
      showStatus(namespace.i18n.t("domains.builtin"));
      return;
    }
    if (settings.customDomains.includes(domain)) {
      showStatus(namespace.i18n.t("domains.exists"));
      return;
    }
    settings = { ...settings, customDomains: [...settings.customDomains, domain] };
    domainInput.value = "";
    await persistSettings({ customDomains: settings.customDomains }, namespace.i18n.t("domains.added"));
  }

  async function removeDomain(domain) {
    settings = { ...settings, customDomains: settings.customDomains.filter((item) => item !== domain) };
    await persistSettings({ customDomains: settings.customDomains }, namespace.i18n.t("domains.removed"));
  }

  function startShortcutCapture() {
    capturingShortcut = true;
    shortcutCapture.classList.add("capturing");
    shortcutCapture.setAttribute("aria-label", namespace.i18n.t("shortcut.recordingAria"));
    renderShortcutTokens([], namespace.i18n.t("shortcut.press"));
  }

  function captureShortcut(event) {
    if (!capturingShortcut) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopShortcutCapture();
      renderShortcut(settings.shortcut);
      showStatus(namespace.i18n.t("shortcut.cancelled"));
      return;
    }
    const shortcut = namespace.historyModel.shortcutFromEvent(event);
    if (!shortcut) {
      const modifiers = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Meta"].filter(Boolean);
      renderShortcutTokens(modifiers, namespace.i18n.t(modifiers.length ? "shortcut.continue" : "shortcut.modifier"));
      return;
    }
    stopShortcutCapture();
    renderShortcut(shortcut);
    persistSettings({ shortcut }, namespace.i18n.t("shortcut.updated"));
  }

  function disableShortcut() {
    stopShortcutCapture();
    renderShortcut("");
    persistSettings({ shortcut: "" }, namespace.i18n.t("shortcut.disabled"));
  }

  function stopShortcutCapture() {
    capturingShortcut = false;
    shortcutCapture.classList.remove("capturing");
    shortcutCapture.setAttribute("aria-label", namespace.i18n.t("shortcut.aria"));
  }

  function renderShortcut(shortcut) {
    shortcutDisable.disabled = !shortcut;
    renderShortcutTokens(shortcut ? shortcut.split("+") : [], shortcut ? "" : namespace.i18n.t("shortcut.empty"));
  }

  function renderShortcutTokens(tokens, placeholder) {
    shortcutCapture.replaceChildren();
    tokens.forEach((token, index) => {
      if (index) appendShortcutPart("span", "key-plus", "+");
      appendShortcutPart("span", "keycap", shortcutTokenLabel(token));
    });
    if (placeholder) appendShortcutPart("span", "shortcut-placeholder", placeholder);
  }

  function appendShortcutPart(tagName, className, text) {
    const part = document.createElement(tagName);
    part.className = className;
    part.textContent = text;
    shortcutCapture.appendChild(part);
  }

  function shortcutTokenLabel(token) {
    return ({ Meta: "Win/⌘", Space: namespace.i18n.t("shortcut.space"), Plus: "+", Minus: "−" })[token] || token;
  }

  function renderDomains() {
    domainList.replaceChildren();
    if (!settings.customDomains.length) {
      const empty = document.createElement("span");
      empty.className = "domain-empty";
      empty.textContent = namespace.i18n.t("domains.empty");
      domainList.appendChild(empty);
      return;
    }
    settings.customDomains.forEach((domain) => {
      const chip = document.createElement("span");
      chip.className = "domain-chip";
      chip.append(document.createTextNode(domain));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", namespace.i18n.t("domains.remove", { domain }));
      remove.textContent = "×";
      remove.addEventListener("click", () => removeDomain(domain));
      chip.appendChild(remove);
      domainList.appendChild(chip);
    });
  }

  function renderProQuota() {
    const target = document.querySelector("#proQuotaStatus");
    target.replaceChildren();
    const active = Object.entries(proQuotaStatus || {})
      .filter(([, value]) => namespace.proQuotaModel?.activeStatus(value));
    if (!active.length) {
      const empty = document.createElement("small");
      empty.textContent = namespace.i18n.t("proQuota.unknown");
      target.appendChild(empty);
      return;
    }
    for (const [model, value] of active) {
      const row = document.createElement("div");
      row.className = "pro-quota-item";
      const modelText = document.createElement("strong");
      modelText.textContent = namespace.proUsageModel.MODEL_LABELS[model] || "Pro";
      const statusText = document.createElement("span");
      let message = namespace.i18n.t("proQuota.resetOnly");
      if (value.status === "limit-reached") message = namespace.i18n.t("proQuota.reached");
      else if (value.status === "remaining-shown" && Number.isSafeInteger(value.remaining)) {
        message = namespace.i18n.t("proQuota.remaining", { count: value.remaining });
      }
      if (Number.isFinite(value.resetAt)) {
        const date = new Intl.DateTimeFormat(namespace.i18n.locale(), {
          dateStyle: "short", timeStyle: "short"
        }).format(new Date(value.resetAt));
        message += " · " + namespace.i18n.t(
          value.approximate ? "proQuota.approxReset" : "proQuota.reset", { time: date }
        );
      }
      statusText.textContent = message;
      row.appendChild(modelText);
      row.appendChild(statusText);
      target.appendChild(row);
    }
  }

  function renderProUsage() {
    proUsageSection.hidden = settings.trackProUsage !== true;
    proUsageSettings.hidden = settings.trackProUsage !== true;
    const all = proUsageStats?.all || { total: 0, today: 0, thisWeek: 0, thisMonth: 0 };
    document.querySelector("#proUsageTotal").textContent = all.total;
    document.querySelector("#proUsageToday").textContent = all.today;
    document.querySelector("#proUsageWeek").textContent = all.thisWeek;
    document.querySelector("#proUsageMonth").textContent = all.thisMonth;
    const budget = namespace.proUsageModel.allowanceOverview({
      plan: settings.proPlan || "unknown", stats: proUsageStats
    });
    const budgetElement = document.querySelector("#proPlanAllowance");
    const currentPlan = namespace.proUsageModel.PLAN_LABELS[settings.proPlan] || "未确认";
    if (budget.monthlyCap !== null) {
      budgetElement.textContent = namespace.i18n.t("proUsage.monthAllowance", {
        plan: currentPlan, cap: budget.monthlyCap, used: budget.usedThisMonth,
        remaining: budget.monthlyRemaining
      });
    } else if (budget.weeklyOrDaily) {
      const gpt6 = namespace.proUsageModel.remainingEstimate({
        plan: settings.proPlan, modelId: "gpt-6-pro", stats: proUsageStats
      });
      const gpt56 = namespace.proUsageModel.remainingEstimate({
        plan: settings.proPlan, modelId: "gpt-5.6-pro", stats: proUsageStats
      });
      budgetElement.textContent = namespace.i18n.t("proUsage.nonMonthlyAllowance", {
        plan: currentPlan, used: budget.usedThisMonth,
        remaining: gpt6?.remaining ?? "?",
        solRemaining: gpt56?.remaining ?? "?"
      });
    } else {
      budgetElement.textContent = namespace.i18n.t("proUsage.unknownAllowance", {
        plan: currentPlan, used: budget.usedThisMonth
      });
    }
    const target = document.querySelector("#proUsageModels");
    target.replaceChildren();
    for (const row of proUsageStats?.rows || []) {
      const entry = document.createElement("div");
      entry.className = "pro-usage-model";
      const label = document.createElement("span");
      label.textContent = row.label;
      const counts = document.createElement("span");
      counts.textContent = namespace.i18n.t("proUsage.modelCount", {
        total: row.total, today: row.today, week: row.thisWeek
      });
      entry.appendChild(label);
      entry.appendChild(counts);
      target.appendChild(entry);
    }
    if (!proUsageStats?.rows?.length) {
      const empty = document.createElement("small");
      empty.textContent = namespace.i18n.t("proUsage.empty");
      target.appendChild(empty);
    }
    document.querySelector("#proUsageRecent").textContent = namespace.i18n.t("proUsage.recent", {
      yesterday: all.yesterday || 0, seven: all.last7Days || 0
    });
    const reset = document.querySelector("#proUsageResetAt");
    reset.textContent = proUsageStats?.resetAt
      ? namespace.i18n.t("proUsage.resetAt", {
        time: new Intl.DateTimeFormat(namespace.i18n.locale(), {
          dateStyle: "medium", timeStyle: "short"
        }).format(new Date(proUsageStats.resetAt))
      }) : "";
    for (const button of document.querySelectorAll("#proUsagePeriods button[data-pro-period]")) {
      button.setAttribute("aria-pressed", String(button.dataset.proPeriod === proUsagePeriod));
    }
    const timeline = document.querySelector("#proUsageTimeline");
    timeline.replaceChildren();
    const history = proUsageStats?.periods?.[proUsagePeriod] || [];
    const max = Math.max(1, ...history.map((row) => row.total));
    for (const row of history) {
      const item = document.createElement("div");
      item.className = "pro-usage-timeline-row";
      const label = document.createElement("span");
      label.textContent = proUsagePeriod === "month" ? row.key : row.key.slice(5);
      const bar = document.createElement("span");
      bar.className = "pro-usage-bar-track";
      const fill = document.createElement("span");
      fill.className = "pro-usage-bar-fill";
      fill.style.width = (row.total / max * 100) + "%";
      bar.appendChild(fill);
      const count = document.createElement("span");
      count.textContent = String(row.total);
      item.title = Object.entries(row.models || {})
        .map(([id, value]) => namespace.proUsageModel.MODEL_LABELS[id] + ": " + value)
        .join(" · ");
      item.appendChild(label);
      item.appendChild(bar);
      item.appendChild(count);
      timeline.appendChild(item);
    }
  }

  function queryBrowserTabs(filter) {
    return new Promise((resolve, reject) => {
      if (!chrome.tabs?.query) {
        reject(new Error("tabs-api-unavailable"));
        return;
      }
      chrome.tabs.query(filter, (tabs) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error("tab-query-failed"));
        else resolve(Array.isArray(tabs) ? tabs : []);
      });
    });
  }

  function readPlanFromTab(tab) {
    return new Promise((resolve) => {
      if (!Number.isInteger(tab?.id) || !chrome.tabs?.sendMessage) {
        resolve({ ok: false, reason: "no-content-script" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      };
      const timeout = setTimeout(() =>
        finish({ ok: false, reason: "tab-response-timeout" }), 19_000);
      try {
        chrome.tabs.sendMessage(tab.id, { type: "AIH_PRO_ACCOUNT_PLAN_READ" }, (result) => {
          const error = chrome.runtime.lastError;
          if (error) {
            const message = error.message || "";
            finish({ ok: false, reason: /receiving end|could not establish connection|no tab with id/i.test(message)
              ? "no-content-script" : "tab-message-failed" });
          } else {
            finish(result && typeof result === "object"
              ? result : { ok: false, reason: "no-content-script" });
          }
        });
      } catch {
        finish({ ok: false, reason: "tab-message-failed" });
      }
    });
  }

  async function locateCurrentChatGPTPlan() {
    // tabs.query returns numeric IDs without asking for the intrusive "tabs"
    // permission. Do not inspect history or read tab titles/content here.
    const active = await queryBrowserTabs({ active: true, currentWindow: true });
    const seen = new Set();
    const failures = [];
    const tryTabs = async (candidates) => {
      for (const tab of candidates) {
        if (!Number.isInteger(tab?.id) || seen.has(tab.id)) continue;
        seen.add(tab.id);
        // URLs may be missing without "tabs" permission. In that case, send
        // only our extension's harmless account-read message to the tab ID.
        if (tab.url && !/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:[/?#]|$)/i.test(tab.url)) {
          continue;
        }
        const result = await readPlanFromTab(tab);
        if (result?.ok && Object.hasOwn(namespace.proUsageModel.PLAN_LABELS, result.plan)
          && result.plan !== "unknown") {
          return { ...result, fromOtherTab: !active.some((row) => row.id === tab.id) };
        }
        if (result?.reason && result.reason !== "no-content-script") failures.push(result.reason);
      }
      return null;
    };
    const first = await tryTabs(active);
    if (first) return first;
    const all = await queryBrowserTabs({});
    const next = await tryTabs(all.slice(0, 60));
    if (next) return next;
    // Keep meaningful server/schema failures ahead of "no receiver" errors.
    const reason = failures.find((value) => /^(session-|accounts-|plan-|tab-response)/.test(value))
      || failures[0] || (seen.size ? "no-content-script" : "no-chatgpt-tab");
    return { ok: false, reason };
  }

  function renderPlanLookupFailure(reason) {
    const code = String(reason || "unknown").slice(0, 60);
    const key = /^(?:session-http-401|session-http-403|accounts-http-401|accounts-http-403)$/.test(code)
      ? "proUsage.detectUnauthorized"
      : /^accounts-multiple-ambiguous$/.test(code) ? "proUsage.detectMultiAccount"
      : /^no-chatgpt-tab$/.test(code) ? "proUsage.detectNoTab"
      : /^(?:no-content-script|tab-message-failed|tab-response-timeout)$/.test(code)
        ? "proUsage.detectRefreshTab"
        : /^(?:session-non-json|session-fetch-failed|accounts-fetch-failed|accounts-non-json)$/.test(code)
          ? "proUsage.detectNetworkError" : "proUsage.detectMissingPlan";
    proPlanDetection.textContent = namespace.i18n.t(key)
      + " [" + code.replace(/[^a-z0-9-]/gi, "") + "]";
    runtimeMessage({ type: "AIH_NOTIFICATION_DEBUG_APPEND", entry: {
      stage: "pro-account-plan-popup", source: "popup", status: "failed", reason: code
    } }).catch(() => {});
  }

  async function detectCurrentAccountPlan({ automatic = false } = {}) {
    const lookupId = ++planLookupId;
    const editId = proPlanEditId;
    const changeId = proUsageChangeId;
    const stale = () => lookupId !== planLookupId || editId !== proPlanEditId
      || (automatic && (changeId !== proUsageChangeId || !requestedProUsage
        || settings.trackProUsage !== true));
    detectProPlanButton.disabled = true;
    proPlanDetection.textContent = namespace.i18n.t("proUsage.detectReading");
    try {
      // Automatic and manual triggers share a single in-flight read. Rapid
      // off/on toggles can reuse it without issuing duplicate account requests.
      if (!planLookupTask) {
        planLookupTask = locateCurrentChatGPTPlan().finally(() => { planLookupTask = null; });
      }
      const result = await planLookupTask;
      await saveQueue;
      if (stale()) return;
      if (!result?.ok || !Object.hasOwn(namespace.proUsageModel.PLAN_LABELS, result.plan)) {
        throw new Error(result?.reason || "plan-not-present");
      }
      const readLabel = namespace.proUsageModel.PLAN_LABELS[result.plan];
      const seatReasonKey = {
        "seat-http-401": "proUsage.seatDenied",
        "seat-http-403": "proUsage.seatDenied",
        "seat-user-unresolved": "proUsage.seatNoIdentity",
        "seat-account-unresolved": "proUsage.seatNoIdentity",
        "seat-type-unrecognized": "proUsage.seatUnknown",
        "seat-legacy-chatgpt-default": "proUsage.seatLegacy",
        "seat-match-not-found": "proUsage.seatMatchMissing",
        "seat-fetch-failed": "proUsage.seatNetwork"
      }[result.seatReason];
      const seatDiagnostic = ["seat-type-unrecognized", "seat-legacy-chatgpt-default"].includes(result.seatReason)
        && typeof result.seatTypeCode === "string"
        && typeof result.seatField === "string"
        ? " · " + namespace.i18n.t("proUsage.seatDiagnostic", {
          field: result.seatField, value: result.seatTypeCode
        }) : "";
      const seatHint = (seatReasonKey ? " · " + namespace.i18n.t(seatReasonKey) : "")
        + seatDiagnostic;
      const legacyDefault = result.seatMapping === "legacy-default-as-standard";
      proPlanDetection.textContent = namespace.i18n.t(legacyDefault
        ? "proUsage.detectLegacyDefault"
        : result.precise ? "proUsage.detectPrecise" : "proUsage.detectGeneric",
      { plan: readLabel }) + (legacyDefault ? "" : seatHint)
        + (result.fromOtherTab ? " · " + namespace.i18n.t("proUsage.detectOtherTab") : "");
      // A generic "pro" or "business" result must not overwrite a manually
      // selected exact tier. Otherwise a plan lookup would silently reset the
      // estimated quota to an unknown amount.
      const currentPlan = settings.proPlan || "unknown";
      const chooseDetected = result.precise || ["unknown", "pro-unverified", "business-unverified",
        "plus", "free", "go"].includes(currentPlan);
      if (legacyDefault && !chooseDetected && currentPlan !== result.plan) {
        proPlanDetection.textContent += " · " + namespace.i18n.t("proUsage.manualPlanPreserved", {
          plan: namespace.proUsageModel.PLAN_LABELS[currentPlan] || currentPlan
        });
      }
      if (chooseDetected && currentPlan !== result.plan) {
        await persistSettings({ proPlan: result.plan }, namespace.i18n.t("status.saved"));
      }
      renderProUsage();
    } catch (error) {
      if (!stale()) {
        renderPlanLookupFailure(error?.message);
        console.warn("[AI Input History] Account plan read failed", String(error?.message || "unknown")
          .replace(/[^a-z0-9-]/gi, "").slice(0, 64));
      }
    } finally {
      if (lookupId === planLookupId) detectProPlanButton.disabled = false;
    }
  }

  async function resetLocalProUsage() {
    const confirmation = namespace.i18n.t("proUsage.resetConfirm");
    if (typeof globalThis.confirm === "function" && !globalThis.confirm(confirmation)) return;
    const button = document.querySelector("#resetProUsage");
    button.disabled = true;
    try {
      const result = await runtimeMessage({ type: "AIH_PRO_USAGE_RESET" });
      if (!result?.ok) throw new Error(result?.error || "Pro usage reset rejected");
      proUsageStats = await store.getProUsageStats();
      renderProUsage();
      showStatus(namespace.i18n.t("proUsage.resetDone"));
    } catch (error) {
      console.error(error);
      showStatus(namespace.i18n.t("proUsage.resetFailed"), true);
    } finally {
      button.disabled = false;
    }
  }

  function renderConversationStats() {
    const all = conversationStats?.all || { total: 0, today: 0, thisWeek: 0, thisMonth: 0 };
    document.querySelector("#conversationTotal").textContent = all.total;
    document.querySelector("#conversationToday").textContent = all.today;
    document.querySelector("#conversationWeek").textContent = all.thisWeek;
    document.querySelector("#conversationMonth").textContent = all.thisMonth;
    conversationStatsList.replaceChildren();
    if (!conversationStats?.rows?.length) {
      const empty = document.createElement("div");
      empty.className = "conversation-stat-empty";
      empty.textContent = namespace.i18n.t("conversation.empty");
      conversationStatsList.appendChild(empty);
      return;
    }
    conversationStats.rows.forEach((row) => conversationStatsList.appendChild(createConversationStatRow(row)));
  }

  function createConversationStatRow(row) {
    const item = document.createElement("div");
    item.className = "conversation-stat-row";
    const identity = document.createElement("div");
    identity.className = "conversation-stat-identity";
    const name = document.createElement("div");
    name.className = "conversation-stat-name";
    const icon = document.createElement("span");
    const profile = namespace.SiteProfiles.PROFILES.find((entry) => entry.id === row.aiKey);
    const iconSite = row.site || profile?.domains?.[0] || row.aiKey.replace(/^custom:/, "");
    icon.innerHTML = namespace.SiteProfiles.icon(iconSite);
    const label = document.createElement("span");
    label.textContent = profile ? namespace.SiteProfiles.displayName(iconSite) : (row.site || row.aiKey.replace(/^custom:/, ""));
    name.appendChild(icon);
    name.appendChild(label);
    identity.appendChild(name);
    item.appendChild(identity);
    [[row.total, "conversation.totalShort"], [row.today, "conversation.todayShort"], [row.thisWeek, "conversation.weekShort"], [row.thisMonth, "conversation.monthShort"]]
      .forEach(([value, key]) => item.appendChild(createConversationMetric(value, key)));
    return item;
  }

  function createConversationMetric(value, key) {
    const metric = document.createElement("div");
    metric.className = "conversation-stat-value";
    metric.textContent = value;
    const label = document.createElement("small");
    label.textContent = namespace.i18n.t(key);
    metric.appendChild(label);
    return metric;
  }

  async function clearConversationStats() {
    clearConversationStatsButton.disabled = true;
    try {
      await store.clearSendStats();
      conversationStats = await store.getSendStats();
      renderConversationStats();
      showStatus(namespace.i18n.t("conversation.cleared"));
    } catch (error) {
      showStatus(namespace.i18n.t("conversation.clearFailed"), true);
      console.error(error);
    } finally {
      clearConversationStatsButton.disabled = false;
    }
  }

  async function clearHistory() {
    const button = document.querySelector("#confirmClear");
    button.disabled = true;
    try {
      await store.clearHistory();
      state = await store.getState();
      renderStats(state);
      closeClearConfirmation();
      showStatus(namespace.i18n.t("status.cleared"));
    } catch (error) {
      clearDialogError.textContent = namespace.i18n.t("clear.error");
      console.error(error);
    } finally {
      button.disabled = false;
    }
  }

  function openClearConfirmation() {
    clearDialogError.textContent = "";
    if (!clearDialog.open) clearDialog.showModal();
    document.querySelector("#cancelClear").focus();
  }

  function closeClearConfirmation() {
    if (clearDialog.open) clearDialog.close();
  }

  function renderStats(current) {
    document.querySelector("#totalCount").textContent = current.entries.length;
    document.querySelector("#sendCount").textContent = current.entries.filter((entry) => entry.kind === "send").length;
    document.querySelector("#draftCount").textContent = Object.keys(current.drafts).length;
  }

  function showStatus(message, isError = false) {
    clearTimeout(statusTimer);
    status.textContent = message;
    status.style.color = isError ? "#ef9f95" : "";
    statusTimer = setTimeout(() => { status.textContent = ""; }, 2800);
  }
})(globalThis.AIInputHistory).catch((error) => {
  document.querySelector("#status").textContent = "无法读取扩展设置，请重新打开 / Cannot load settings. Reopen this popup.";
  console.error("[AI Input History]", error);
});
