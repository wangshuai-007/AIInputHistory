(async function initializePopup(namespace) {
  "use strict";

  const store = new namespace.HistoryStore();
  const numericFields = ["historyLimit", "sendLimit", "snapshotSeconds"];
  const status = document.querySelector("#status");
  const launcherToggle = document.querySelector("#launcherEnabled");
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

  numericFields.forEach((name) => {
    const input = document.querySelector(`#${name}`);
    input.value = settings[name];
    input.addEventListener("input", () => {
      if (input.value !== "" && input.validity.valid) persistSettings({ [name]: input.value }, namespace.i18n.t("status.saved"), false);
    });
    input.addEventListener("change", () => persistSettings({ [name]: input.value }, namespace.i18n.t("status.saved")));
  });
  launcherToggle.checked = settings.launcherEnabled;
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

  function persistSettings(patch, message, normalizeInputs = true) {
    saveQueue = saveQueue.then(async () => {
      try {
        settings = await store.saveSettings({ ...settings, ...patch });
        if (normalizeInputs) numericFields.forEach((name) => { document.querySelector(`#${name}`).value = settings[name]; });
        launcherToggle.checked = settings.launcherEnabled;
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
})(globalThis.AIInputHistory);
