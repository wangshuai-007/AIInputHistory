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
    "#shortcutCapture", "#shortcutDisable", "#clearDialog", "#clearDialogError", "#cancelClear", "#confirmClear"
  ].map((selector) => [selector, element()]));
  const saves = [];
  let clearCount = 0;
  class HistoryStore {
    async getSettings() {
      return { historyLimit: 100, sendLimit: 10, snapshotSeconds: 60, shortcut: "Ctrl+R", launcherEnabled: true, customDomains: [] };
    }
    async getState() { return { entries: [], drafts: {} }; }
    async saveSettings(settings) { saves.push(settings); return { ...settings, snapshotSeconds: Number(settings.snapshotSeconds) }; }
    async clearHistory() { clearCount += 1; }
  }
  const context = {
    AIInputHistory: { HistoryStore, historyModel: {
      shortcutFromEvent(event) { return event.ctrlKey && event.code === "KeyK" ? "Ctrl+K" : ""; },
      normalizeDomain() { return ""; }
    } },
    document: {
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
