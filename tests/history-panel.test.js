const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "history-panel.js"), "utf8");

function classList() {
  const values = new Set();
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name)
  };
}

test("自动快照保存反馈可重复触发并在结束后复位", () => {
  let finishAnimation;
  const context = {
    globalThis: {},
    clearTimeout() {},
    setTimeout(callback) { finishAnimation = callback; return 1; },
    requestAnimationFrame(callback) { callback(); }
  };
  vm.runInNewContext(source, context);
  const launcherClasses = classList();
  const panelClasses = classList();
  const instance = {
    launcherEnabled: true,
    target: {},
    launcher: { classList: launcherClasses, offsetWidth: 34 },
    panel: { classList: panelClasses },
    savedStatus: { textContent: "" },
    isOpen: () => true
  };

  context.globalThis.AIInputHistory.HistoryPanel.prototype.showSavedFeedback.call(instance);
  assert.equal(launcherClasses.contains("aih-saved"), true);
  assert.equal(panelClasses.contains("aih-saved"), true);
  assert.equal(instance.savedStatus.textContent, "自动快照已保存");

  finishAnimation();
  assert.equal(launcherClasses.contains("aih-saved"), false);
  assert.equal(panelClasses.contains("aih-saved"), false);
});
