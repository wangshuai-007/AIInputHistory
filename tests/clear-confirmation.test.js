const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "clear-confirmation.js"), "utf8");
const i18nSource = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");

function classes() {
  const values = new Set(["hidden"]);
  return { add: (name) => values.add(name), remove: (name) => values.delete(name), contains: (name) => values.has(name) };
}

test("清除历史只在确认弹窗中确认后执行", async () => {
  const listeners = {};
  const dialog = { open: false, addEventListener(type, listener) { listeners[type] = listener; }, showModal() { this.open = true; }, close() { this.open = false; } };
  const error = { textContent: "", classList: classes() };
  const cancel = { addEventListener(type, listener) { listeners[`cancel-${type}`] = listener; }, focus() {} };
  const accept = { disabled: false, addEventListener(type, listener) { listeners[`accept-${type}`] = listener; } };
  const root = { querySelector(selector) { return ({ ".clear-dialog": dialog, ".confirm-error": error, ".confirm-cancel": cancel, ".confirm-accept": accept })[selector]; } };
  let clearCount = 0;
  const context = { globalThis: {}, console };
  vm.runInNewContext(i18nSource, context);
  vm.runInNewContext(source, context);
  const confirmation = new context.globalThis.AIInputHistory.ClearConfirmation(root, async () => { clearCount += 1; });

  confirmation.open();
  assert.equal(dialog.open, true);
  assert.equal(clearCount, 0);
  await confirmation.confirm();
  assert.equal(clearCount, 1);
  assert.equal(dialog.open, false);
  assert.equal(accept.disabled, false);
});
