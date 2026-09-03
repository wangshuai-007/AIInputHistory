const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");

test("界面语言可在中文和英文之间即时切换", () => {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  const i18n = context.globalThis.AIInputHistory.i18n;

  assert.equal(i18n.t("panel.title"), "输入历史");
  i18n.setLanguage("en");
  assert.equal(i18n.t("panel.title"), "Input history");
  assert.equal(i18n.t("panel.count", { count: 3 }), "3 items");
  assert.equal(i18n.locale(), "en-US");
});

test("未知语言会安全回退到中文", () => {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  const i18n = context.globalThis.AIInputHistory.i18n;
  i18n.setLanguage("unknown");
  assert.equal(i18n.language(), "zh-CN");
  assert.equal(i18n.t("clear.cancel"), "取消");
});
