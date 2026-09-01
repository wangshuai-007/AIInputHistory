const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "theme-observer.js"), "utf8");
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const { relativeLuminance } = context.globalThis.AIInputHistory.themeModel;

test("页面背景亮度可区分深色和浅色主题", () => {
  assert.ok(relativeLuminance([16, 20, 18]) < 0.36);
  assert.ok(relativeLuminance([248, 250, 249]) > 0.36);
});
