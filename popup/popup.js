(async function initializePopup(namespace) {
  "use strict";

  const store = new namespace.HistoryStore();
  const numericFields = ["historyLimit", "sendLimit", "snapshotSeconds"];
  const status = document.querySelector("#status");
  const launcherToggle = document.querySelector("#launcherEnabled");
  const timingToggle = document.querySelector("#trackRequestTime");
  const notifyToggle = document.querySelector("#notifyEnabled");
  const notifyProvider = document.querySelector("#notifyProvider");
  const testNotificationButton = document.querySelector("#testNotification");
  const notificationInputs = {
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
  let [settings, state] = await Promise.all([store.getSettings(), store.getState()]);
  namespace.i18n.setLanguage(settings.language);
  let saveQueue = Promise.resolve();
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
  renderNotificationSettings();
  notifyToggle.addEventListener("change", changeNotificationEnabled);
  notifyProvider.addEventListener("change", changeNotificationProvider);
  Object.values(notificationInputs).forEach((selector) => document.querySelector(selector).addEventListener("change", saveNotificationConfig));
  testNotificationButton.addEventListener("click", testNotification);
  launcherToggle.addEventListener("change", () => persistSettings(
    { launcherEnabled: launcherToggle.checked },
    namespace.i18n.t(launcherToggle.checked ? "status.launcherOn" : "status.launcherOff")
  ));
  languageSelect.addEventListener("change", changeLanguage);
  document.querySelector("#domainForm").addEventListener("submit", addDomain);
  document.querySelector("#clear").addEventListener("click", openClearConfirmation);
  document.querySelector("#cancelClear").addEventListener("click", closeClearConfirmation);
  document.querySelector("#confirmClear").addEventListener("click", clearHistory);
  clearDialog.addEventListener("cancel", () => { clearDialogError.textContent = ""; });
  shortcutCapture.addEventListener("click", startShortcutCapture);
  shortcutCapture.addEventListener("keydown", captureShortcut);
  shortcutDisable.addEventListener("click", disableShortcut);
  renderStats(state);
  applyLanguage();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[namespace.STORAGE_KEYS.state]?.newValue) renderStats(changes[namespace.STORAGE_KEYS.state].newValue);
    const next = changes[namespace.STORAGE_KEYS.settings]?.newValue;
    if (!next) return;
    settings = namespace.historyModel.sanitizeSettings(next);
    launcherToggle.checked = settings.launcherEnabled;
    timingToggle.checked = settings.trackRequestTime;
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
        renderNotificationSettings();
        if (patch.language) namespace.i18n.setLanguage(settings.language);
        applyLanguage();
        showStatus(message);
      } catch (error) {
        showStatus(namespace.i18n.t("status.saveFailed"), true);
        console.error(error);
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
    if (!capturingShortcut) renderShortcut(settings.shortcut);
  }

  function collectNotificationConfig(overrides = {}) {
    const current = settings.completionNotification || {};
    const value = (name) => document.querySelector(notificationInputs[name]).value;
    return {
      ...current, enabled: notifyToggle.checked, provider: notifyProvider.value,
      barkUrl: value("barkUrl"), serverChanKey: value("serverChanKey"), pushPlusToken: value("pushPlusToken"),
      ntfyUrl: value("ntfyUrl"), ntfyTopic: value("ntfyTopic"), gotifyUrl: value("gotifyUrl"), gotifyToken: value("gotifyToken"),
      dingtalkWebhook: value("dingtalkWebhook"), feishuWebhook: value("feishuWebhook"), wecomWebhook: value("wecomWebhook"),
      customMethod: value("customMethod"), customUrl: value("customUrl"), customHeaders: value("customHeaders"), customBody: value("customBody"),
      ...overrides
    };
  }

  function renderNotificationSettings() {
    const config = settings.completionNotification || { enabled: false, provider: "browser" };
    notifyToggle.checked = config.enabled === true;
    notifyProvider.value = config.provider || "browser";
    Object.entries(notificationInputs).forEach(([name, selector]) => { document.querySelector(selector).value = config[name] ?? ""; });
    document.querySelectorAll("[data-notify-provider]").forEach((section) => {
      const active = section.dataset.notifyProvider === notifyProvider.value;
      active ? section.classList.add("active") : section.classList.remove("active");
    });
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

  async function testNotification() {
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
      testNotificationButton.disabled = false;
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
