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

test("快速上下键共享首次加载且按按键顺序恢复原文", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  const input = { value: "当前草稿" };
  const adapter = { getText: (target) => target.value, setText: (target, text) => { target.value = text; } };
  let resolveHistory;
  let reads = 0;
  const store = { getHistory() { reads += 1; return new Promise((resolve) => { resolveHistory = resolve; }); } };
  const navigator = new context.globalThis.AIInputHistory.HistoryNavigator(store, adapter);
  const composition = { site: "chatgpt.com", fieldKey: "composer", sessionId: "a" };
  const up = navigator.move("up", input, composition);
  const down = navigator.move("down", input, composition);
  assert.equal(reads, 1);
  resolveHistory([{ text: "历史", kind: "send" }]);
  await Promise.all([up, down]);
  assert.equal(input.value, "当前草稿");
  assert.equal(navigator.index, -1);
});

test("过期历史加载不能覆盖切换输入框后的文本", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  const oldInput = { value: "旧草稿" };
  const newInput = { value: "新草稿" };
  const adapter = { getText: (target) => target.value, setText: (target, text) => { target.value = text; } };
  const pending = [];
  const store = { getHistory() { return new Promise((resolve) => pending.push(resolve)); } };
  const navigator = new context.globalThis.AIInputHistory.HistoryNavigator(store, adapter);
  const oldMove = navigator.move("up", oldInput, { site: "chatgpt.com" });
  navigator.reset();
  const newMove = navigator.move("up", newInput, { site: "gemini.google.com" });
  pending[1]([{ text: "新网站历史", kind: "send" }]);
  await newMove;
  pending[0]([{ text: "旧网站历史", kind: "send" }]);
  assert.equal(await oldMove, false);
  assert.equal(oldInput.value, "旧草稿");
  assert.equal(newInput.value, "新网站历史");
});

test("同一页面其他窗口的草稿仍可被上下键访问", async () => {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context);
  const input = { value: "当前草稿" };
  const adapter = { getText: (target) => target.value, setText: (target, text) => { target.value = text; } };
  const store = { async getHistory() {
    return [
      { text: "当前草稿", kind: "draft", fieldKey: "composer", sessionId: "current" },
      { text: "另一个窗口", kind: "draft", fieldKey: "composer", sessionId: "other" }
    ];
  } };
  const navigator = new context.globalThis.AIInputHistory.HistoryNavigator(store, adapter);
  await navigator.move("up", input, { site: "chatgpt.com", fieldKey: "composer", sessionId: "current" });
  assert.equal(input.value, "另一个窗口");
});
