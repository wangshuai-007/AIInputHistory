const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");

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
    "#historyLimit", "#sendLimit", "#snapshotSeconds", "#launcherEnabled", "#domainInput",
    "#domainList", "#domainForm", "#clear", "#status", "#totalCount", "#sendCount", "#draftCount",
    "#shortcutCapture", "#shortcutDisable", "#languageSelect", "#clearDialog", "#clearDialogError", "#cancelClear", "#confirmClear", "#extensionVersion"
  ].map((selector) => [selector, element()]));
  const saves = [];
  let clearCount = 0;
  class HistoryStore {
    async getSettings() {
      return { historyLimit: 100, sendLimit: 10, snapshotSeconds: 60, shortcut: "Ctrl+R", language: "zh-CN", launcherEnabled: true, customDomains: [] };
    }
    async getState() { return { entries: [], drafts: {} }; }
    async patchSettings(patch) { saves.push(patch); return { ...await this.getSettings(), ...patch, snapshotSeconds: Number(patch.snapshotSeconds || 60) }; }
    async clearHistory() { clearCount += 1; }
  }
  const context = {
    chrome: { runtime: { getManifest: () => ({ version: "1.26.0" }) }, storage: { onChanged: { addListener(listener) { context.storageListener = listener; } } } },
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
      createElement: () => element(),
      createTextNode: (text) => ({ text })
    },
    setTimeout: () => 1,
    clearTimeout() {},
    console
  };
  context.globalThis = context;
  await vm.runInNewContext(source, context);

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
  assert.deepEqual(Object.keys(saves[0]), ["snapshotSeconds"]);

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
