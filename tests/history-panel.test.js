const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "history-panel.js"), "utf8");
const utilsSource = fs.readFileSync(path.join(__dirname, "..", "src", "history-panel-utils.js"), "utf8");

function loadPanel(context) {
  vm.runInNewContext(utilsSource, context);
  vm.runInNewContext(source, context);
}

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
  loadPanel(context);
  const panelPrototype = context.globalThis.AIInputHistory.HistoryPanel.prototype;
  const launcherClasses = classList();
  const panelClasses = classList();
  const instance = {
    launcherEnabled: true,
    target: {},
    launcher: { classList: launcherClasses, offsetWidth: 34 },
    panel: { classList: panelClasses },
    savedStatus: { textContent: "" },
    launcherTooltip: { textContent: "" },
    setLastSavedAt: panelPrototype.setLastSavedAt,
    isOpen: () => true
  };

  panelPrototype.showSavedFeedback.call(instance, Date.now());
  assert.equal(launcherClasses.contains("aih-saved"), true);
  assert.equal(panelClasses.contains("aih-saved"), true);
  assert.equal(instance.savedStatus.textContent, "自动快照已保存");
  assert.match(instance.launcherTooltip.textContent, /^上次自动保存：今天 /);

  finishAnimation();
  assert.equal(launcherClasses.contains("aih-saved"), false);
  assert.equal(panelClasses.contains("aih-saved"), false);
});
