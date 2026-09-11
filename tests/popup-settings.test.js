const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup", "index.html"), "utf8");

test("ChatGPT 专属设置集中在独立分组框中", () => {
  const generalStart = popupHtml.indexOf('<section class="settings">');
  const chatgptStart = popupHtml.indexOf('<section class="chatgpt-settings">');
  const domainsStart = popupHtml.indexOf('<section class="domains">');
  assert.ok(generalStart >= 0 && chatgptStart > generalStart && domainsStart > chatgptStart);
  const generalBlock = popupHtml.slice(generalStart, chatgptStart);
  const chatgptBlock = popupHtml.slice(chatgptStart, domainsStart);
  assert.doesNotMatch(generalBlock, /trackRequestTime|notifyEnabled/);
  assert.match(chatgptBlock, /chatgpt\.title/);
  assert.match(chatgptBlock, /trackRequestTime/);
  assert.match(chatgptBlock, /notifyEnabled/);
  assert.ok(chatgptBlock.indexOf("trackRequestTime") < chatgptBlock.indexOf("notifyEnabled"));
});

function element() {
  const listeners = {};
  const classes = new Set();
  return {
    listeners,
    open: false,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    style: {},
    validity: { valid: true },
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild() {},
    replaceChildren() {},
    setAttribute() {},
    focus() {},
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
}

test("修改自动快照秒数时无需关闭输入框即可立即保存", async () => {
  const elements = Object.fromEntries([
    "#historyLimit", "#sendLimit", "#snapshotSeconds", "#launcherEnabled", "#domainInput", "#trackRequestTime",
    "#notifyEnabled", "#notifyProvider", "#notifyMinDurationSeconds", "#testNotification", "#notifyBarkUrl", "#notifyServerChanKey", "#notifyPushPlusToken",
    "#notifyNtfyUrl", "#notifyNtfyTopic", "#notifyGotifyUrl", "#notifyGotifyToken", "#notifyDingtalkWebhook", "#notifyFeishuWebhook", "#notifyWecomWebhook", "#notifyCustomMethod", "#notifyCustomUrl", "#notifyCustomHeaders", "#notifyCustomBody",
    "#domainList", "#domainForm", "#clear", "#status", "#totalCount", "#sendCount", "#draftCount",
    "#shortcutCapture", "#shortcutDisable", "#languageSelect", "#clearDialog", "#clearDialogError", "#cancelClear", "#confirmClear", "#extensionVersion"
  ].map((selector) => [selector, element()]));
  const saves = [];
  let clearCount = 0;
  class HistoryStore {
    async getSettings() {
      return {
        historyLimit: 100, sendLimit: 10, snapshotSeconds: 60, shortcut: "Ctrl+R", language: "zh-CN", launcherEnabled: true, trackRequestTime: false,
        completionNotification: { enabled: false, provider: "browser", minDurationSeconds: 20, barkUrl: "", serverChanKey: "", pushPlusToken: "", ntfyUrl: "https://ntfy.sh", ntfyTopic: "", gotifyUrl: "", gotifyToken: "", dingtalkWebhook: "", feishuWebhook: "", wecomWebhook: "", customMethod: "POST", customUrl: "", customHeaders: "{}", customBody: '{"title":"{{title}}","message":"{{message}}"}' },
        customDomains: []
      };
    }
    async getState() { return { entries: [], drafts: {} }; }
    async patchSettings(patch) { saves.push(patch); return { ...await this.getSettings(), ...patch, snapshotSeconds: Number(patch.snapshotSeconds || 60) }; }
    async clearHistory() { clearCount += 1; }
  }
  const context = {
    chrome: {
      runtime: { lastError: null, getManifest: () => ({ version: "1.26.0" }), sendMessage(message, callback) { callback({ ok: true, type: message.type }); } },
      permissions: { request(request, callback) { context.permissionRequests.push(request); callback(true); } },
      storage: { onChanged: { addListener(listener) { context.storageListener = listener; } }
      }
    },
    permissionRequests: [],
    AIInputHistory: { HistoryStore, i18n: (() => {
      let language = "zh-CN";
      return { setLanguage(value) { language = value === "en" ? "en" : "zh-CN"; }, language: () => language, localize() {}, t: (key) => key };
    })(), historyModel: {
      shortcutFromEvent(event) { return event.ctrlKey && event.code === "KeyK" ? "Ctrl+K" : ""; },
      normalizeDomain() { return ""; },
      sanitizeSettings(value) { return value; }
    }, STORAGE_KEYS: { settings: "settings", state: "state" } },
    document: {
      documentElement: { lang: "" },
      querySelector: (selector) => elements[selector],
      querySelectorAll: () => [],
      createElement: () => element(),
      createTextNode: (text) => ({ text })
    },
    setTimeout: () => 1,
    clearTimeout() {},
    console
  };
  context.globalThis = context;
  await vm.runInNewContext(source, context);

  assert.equal(elements["#notifyProvider"].disabled, true);
  assert.equal(elements["#notifyMinDurationSeconds"].disabled, true);
  assert.equal(elements["#notifyMinDurationSeconds"].value, 20);
  assert.equal(elements["#testNotification"].disabled, true);
  assert.equal(elements["#notifyNtfyUrl"].disabled, true);

  const snapshotInput = elements["#snapshotSeconds"];
  snapshotInput.value = "5";
  snapshotInput.listeners.input();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(saves.at(-1).snapshotSeconds, "5");

  const shortcutCapture = elements["#shortcutCapture"];
  shortcutCapture.listeners.click();
  shortcutCapture.listeners.keydown({ key: "k", code: "KeyK", ctrlKey: true, preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).shortcut, "Ctrl+K");

  elements["#languageSelect"].value = "en";
  elements["#languageSelect"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).language, "en");
  assert.equal(context.document.documentElement.lang, "en");
  assert.equal(elements["#extensionVersion"].textContent, "v1.26.0");
  context.storageListener({ settings: { newValue: { ...await new HistoryStore().getSettings(), launcherEnabled: false } } }, "local");
  assert.equal(elements["#launcherEnabled"].checked, false);
  elements["#trackRequestTime"].checked = true;
  elements["#trackRequestTime"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).trackRequestTime, true);
  assert.deepEqual(Object.keys(saves[0]), ["snapshotSeconds"]);

  elements["#notifyEnabled"].checked = true;
  elements["#notifyEnabled"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.permissionRequests.at(-1).permissions[0], "notifications");
  assert.equal(saves.at(-1).completionNotification.enabled, true);
  assert.equal(saves.at(-1).completionNotification.provider, "browser");
  assert.equal(elements["#notifyProvider"].disabled, false);
  assert.equal(elements["#notifyMinDurationSeconds"].disabled, false);
  assert.equal(elements["#testNotification"].disabled, false);
  assert.equal(elements["#notifyNtfyUrl"].disabled, false);

  elements["#notifyMinDurationSeconds"].value = "30";
  elements["#notifyMinDurationSeconds"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).completionNotification.minDurationSeconds, "30");

  elements["#notifyEnabled"].checked = false;
  elements["#notifyEnabled"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["#notifyProvider"].disabled, true);
  assert.equal(elements["#notifyMinDurationSeconds"].disabled, true);
  assert.equal(elements["#testNotification"].disabled, true);
  assert.equal(elements["#notifyNtfyUrl"].disabled, true);

  elements["#clear"].listeners.click();
  assert.equal(elements["#clearDialog"].open, true);
  assert.equal(clearCount, 0);
  elements["#cancelClear"].listeners.click();
  assert.equal(elements["#clearDialog"].open, false);
  elements["#clear"].listeners.click();
  await elements["#confirmClear"].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearCount, 1);
});
