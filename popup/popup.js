(async function initializePopup(namespace) {
  "use strict";

  const store = new namespace.HistoryStore();
  const numericFields = ["historyLimit", "sendLimit", "snapshotSeconds"];
  const status = document.querySelector("#status");
  const launcherToggle = document.querySelector("#launcherEnabled");
  const domainInput = document.querySelector("#domainInput");
  const domainList = document.querySelector("#domainList");
  let [settings, state] = await Promise.all([store.getSettings(), store.getState()]);
  let saveQueue = Promise.resolve();
  let statusTimer = null;

  numericFields.forEach((name) => {
    const input = document.querySelector(`#${name}`);
    input.value = settings[name];
    input.addEventListener("input", () => {
      if (input.value !== "" && input.validity.valid) persistSettings({ [name]: input.value }, "设置已保存并立即生效", false);
    });
    input.addEventListener("change", () => persistSettings({ [name]: input.value }, "设置已保存并立即生效"));
  });
  launcherToggle.checked = settings.launcherEnabled;
  launcherToggle.addEventListener("change", () => persistSettings(
    { launcherEnabled: launcherToggle.checked },
    launcherToggle.checked ? "悬浮按钮已立即开启" : "悬浮按钮已立即关闭"
  ));
  document.querySelector("#domainForm").addEventListener("submit", addDomain);
  document.querySelector("#clear").addEventListener("click", clearHistory);
  renderStats(state);
  renderDomains();

  function persistSettings(patch, message, normalizeInputs = true) {
    saveQueue = saveQueue.then(async () => {
      try {
        settings = await store.saveSettings({ ...settings, ...patch });
        if (normalizeInputs) numericFields.forEach((name) => { document.querySelector(`#${name}`).value = settings[name]; });
        launcherToggle.checked = settings.launcherEnabled;
        renderDomains();
        showStatus(message);
      } catch (error) {
        showStatus("保存失败，请重试", true);
        console.error(error);
      }
    });
    return saveQueue;
  }

  async function addDomain(event) {
    event.preventDefault();
    const domain = namespace.historyModel.normalizeDomain(domainInput.value);
    if (!domain) {
      showStatus("请输入有效域名，例如 ai.example.com", true);
      return;
    }
    if (namespace.SiteProfiles.forSite(domain)) {
      showStatus("该 AI 网站已默认支持，无需添加");
      return;
    }
    if (settings.customDomains.includes(domain)) {
      showStatus("该域名已添加");
      return;
    }
    settings = { ...settings, customDomains: [...settings.customDomains, domain] };
    domainInput.value = "";
    await persistSettings({ customDomains: settings.customDomains }, "域名已添加，刷新该网站后生效");
  }

  async function removeDomain(domain) {
    settings = { ...settings, customDomains: settings.customDomains.filter((item) => item !== domain) };
    await persistSettings({ customDomains: settings.customDomains }, "域名已移除，刷新页面后停止追踪");
  }

  function renderDomains() {
    domainList.replaceChildren();
    if (!settings.customDomains.length) {
      const empty = document.createElement("span");
      empty.className = "domain-empty";
      empty.textContent = "尚未添加自定义域名";
      domainList.appendChild(empty);
      return;
    }
    settings.customDomains.forEach((domain) => {
      const chip = document.createElement("span");
      chip.className = "domain-chip";
      chip.append(document.createTextNode(domain));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.setAttribute("aria-label", `移除 ${domain}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => removeDomain(domain));
      chip.appendChild(remove);
      domainList.appendChild(chip);
    });
  }

  async function clearHistory() {
    const button = document.querySelector("#clear");
    if (button.dataset.confirm !== "true") {
      button.dataset.confirm = "true";
      button.textContent = "再次点击确认清空";
      setTimeout(() => {
        button.dataset.confirm = "false";
        button.textContent = "清空本地记录";
      }, 3000);
      return;
    }
    await store.clearHistory();
    state = await store.getState();
    renderStats(state);
    button.dataset.confirm = "false";
    button.textContent = "清空本地记录";
    showStatus("本地记录已清空");
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
