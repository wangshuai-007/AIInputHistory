const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function setup() {
  const tasks = [];
  const listeners = new Map();
  const sent = [];
  const requests = [];
  const cancelledRequests = [];
  const input = {
    text: "第一行", isConnected: true,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); }
  };
  const context = {
    globalThis: {},
    setTimeout(callback, delay) { tasks.push({ callback, delay }); }
  };
  context.globalThis.AIInputHistory = { SiteProfiles: { isSendShortcut: (event) => event.defaultPrevented && !event.shiftKey } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "send-detector.js"), "utf8"), context);
  const detector = new context.globalThis.AIInputHistory.SendDetector(
    { getText: (element) => element.text },
    (...args) => sent.push(args),
    () => ({ startedAt: 1, baseline: {} }),
    (field, metadata) => { const handle = { field, metadata }; requests.push(handle); return handle; },
    (handle) => cancelledRequests.push(handle)
  );
  const field = { fieldKey: "chat", site: "chatgpt.com" };
  const event = { key: "Enter", defaultPrevented: true };
  const tick = (delay) => tasks.filter((item) => item.delay === delay).forEach((item) => item.callback());
  return { input, detector, field, event, tick, sent, listeners, requests, cancelledRequests };
}

test("AI 延迟插入换行时会撤销提前开始的请求观察且不保存发送", () => {
  const h = setup();
  h.detector.watchEnter(h.event, h.input, h.field);
  h.tick(0);
  h.tick(40);
  assert.equal(h.requests.length, 1);
  assert.equal(h.sent.length, 0);
  h.input.text += "\n";
  h.listeners.get("input")({ inputType: "insertParagraph" });
  h.input.text = "";
  h.tick(140);
  h.tick(900);
  assert.equal(h.sent.length, 0);
  assert.equal(h.cancelledRequests.length, 1);
  assert.equal(h.listeners.size, 0);
});

test("未被页面接管的 Enter 遇到输入框移除不会虚构发送历史", () => {
  const h = setup();
  h.detector.watchEnter({ ...h.event, defaultPrevented: false }, h.input, h.field);
  h.input.isConnected = false;
  h.tick(40);
  h.tick(900);
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.listeners.size, 0);
});

test("ChatGPT 接管 Enter 后立即开始请求观察，输入框被替换仍按发送处理", () => {
  const h = setup();
  h.detector.watchEnter(h.event, h.input, h.field);
  h.tick(0);
  assert.equal(h.requests.length, 1, "页面 preventDefault 后应立即开始计时观察");
  h.input.isConnected = false;
  h.tick(40);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][2], "keyboard-replaced");
  assert.equal(h.cancelledRequests.length, 0);
  assert.equal(h.listeners.size, 0);
});

test("发送按钮右键和非主指针不会记录发送", () => {
  const h = setup();
  h.detector.handlePointerDown({ button: 2 }, h.input, h.field);
  h.detector.handlePointerDown({ type: "pointerdown", button: 0, isPrimary: false }, h.input, h.field);
  assert.equal(h.sent.length, 0);
});

test("按键重复和输入法确认不会新建发送观察", () => {
  const h = setup();
  h.detector.watchEnter({ ...h.event, repeat: true }, h.input, h.field);
  h.detector.watchEnter({ ...h.event, isComposing: true }, h.input, h.field);
  assert.equal(h.listeners.size, 0);
});

test("真实清空只发送一次并移除观察事件", () => {
  const h = setup();
  h.detector.watchEnter(h.event, h.input, h.field);
  h.input.text = "";
  h.tick(40);
  h.tick(900);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0][0], "第一行");
  assert.equal(h.listeners.size, 0);
});

test("Shift Enter 未改变内容时不会被失败发送兜底记录", () => {
  const h = setup();
  h.detector.watchEnter({ ...h.event, shiftKey: true }, h.input, h.field);
  h.tick(900);
  assert.equal(h.sent.length, 0);
});
