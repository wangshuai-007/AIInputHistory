const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "history-navigator.js"), "utf8");

test("上下键像 Console 一样连续切换历史并在向下越界时恢复原文", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  const input = { value: "正在编辑" };
  let navigator;
  const adapter = {
    getText: (target) => target.value,
    setText(target, text) {
      assert.equal(navigator.isApplying(), true);
      target.value = text;
    }
  };
  const store = { async getHistory() {
    return [
      { text: "正在编辑", kind: "draft", fieldKey: "composer", createdAt: 40 },
      { text: "当前快照", kind: "snapshot", fieldKey: "composer", sessionId: "current", createdAt: 35 },
      { text: "上一条命令", kind: "send", fieldKey: "composer", sessionId: "previous", createdAt: 30 },
      { text: "更早的命令", kind: "send", fieldKey: "composer", sessionId: "older", createdAt: 20 }
    ];
  } };
  navigator = new context.globalThis.AIInputHistory.HistoryNavigator(store, adapter);
  const composition = { site: "chatgpt.com", fieldKey: "composer", sessionId: "current" };

  assert.equal(await navigator.move("up", input, composition), true);
  assert.equal(input.value, "上一条命令");
  assert.equal(await navigator.move("up", input, composition), true);
  assert.equal(input.value, "更早的命令");
  assert.equal(await navigator.move("down", input, composition), true);
  assert.equal(input.value, "上一条命令");
  assert.equal(await navigator.move("down", input, composition), true);
  assert.equal(input.value, "正在编辑");
});

test("用户重新输入后会从最新历史重新开始", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  const input = { value: "草稿" };
  const adapter = { getText: (target) => target.value, setText: (target, text) => { target.value = text; } };
  const store = { async getHistory() { return [{ text: "历史一", kind: "send", fieldKey: "composer" }]; } };
  const navigator = new context.globalThis.AIInputHistory.HistoryNavigator(store, adapter);

  await navigator.move("up", input, { site: "chatgpt.com", fieldKey: "composer" });
  input.value = "新草稿";
  navigator.reset();
  await navigator.move("down", input, { site: "chatgpt.com", fieldKey: "composer" });
  assert.equal(input.value, "新草稿");
});
