const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");

function element() {
  const listeners = {};
  return {
    listeners,
    style: {},
    validity: { valid: true },
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild() {},
    replaceChildren() {},
    setAttribute() {}
  };
}

test("修改自动快照秒数时无需关闭输入框即可立即保存", async () => {
  const elements = Object.fromEntries([
    "#historyLimit", "#sendLimit", "#snapshotSeconds", "#launcherEnabled", "#domainInput",
    "#domainList", "#domainForm", "#clear", "#status", "#totalCount", "#sendCount", "#draftCount"
  ].map((selector) => [selector, element()]));
  const saves = [];
  class HistoryStore {
    async getSettings() {
      return { historyLimit: 100, sendLimit: 10, snapshotSeconds: 60, launcherEnabled: true, customDomains: [] };
    }
    async getState() { return { entries: [], drafts: {} }; }
    async saveSettings(settings) { saves.push(settings); return { ...settings, snapshotSeconds: Number(settings.snapshotSeconds) }; }
  }
  const context = {
    AIInputHistory: { HistoryStore },
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
});
