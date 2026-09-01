const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "send-detector.js"), "utf8");
const context = {
  globalThis: {
    AIInputHistory: {
      SiteProfiles: {
        isSendShortcut: (event, site) => site === "chatgpt.com" && event.key === "Enter" && !event.shiftKey
      }
    }
  }
};
vm.runInNewContext(source, context);
const { didComposerClear } = context.globalThis.AIInputHistory.sendDetection;
const { SendDetector } = context.globalThis.AIInputHistory;

test("输入框清空或被移除时判定为实际发送", () => {
  assert.equal(didComposerClear("待发送内容", "", true), true);
  assert.equal(didComposerClear("待发送内容", "待发送内容", false), true);
});

test("Enter 产生换行时不判定为发送", () => {
  assert.equal(didComposerClear("第一行", "第一行\n", true), false);
  assert.equal(didComposerClear("第一行", "第一行\n第二行", true), false);
});

test("空内容不会被判定为发送", () => {
  assert.equal(didComposerClear("   ", "", true), false);
});

test("内置 AI 按发送快捷键时立即记录，不等待页面响应", () => {
  let emission = null;
  const detector = new SendDetector({ getText: () => "页面失败也要保存" }, (text, context, source) => { emission = { text, context, source }; });
  detector.watchEnter({ key: "Enter", shiftKey: false, isComposing: false }, {}, { fieldKey: "chatgpt", site: "chatgpt.com" });
  assert.equal(emission.text, "页面失败也要保存");
  assert.equal(emission.source, "keyboard-attempt");
});
