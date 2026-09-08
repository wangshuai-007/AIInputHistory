const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function setup() {
  const tasks = [];
  const listeners = new Map();
  const sent = [];
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
  const detector = new context.globalThis.AIInputHistory.SendDetector({ getText: (element) => element.text }, (...args) => sent.push(args));
  const field = { fieldKey: "chat", site: "chatgpt.com" };
  const event = { key: "Enter", defaultPrevented: true };
  const tick = (delay) => tasks.filter((item) => item.delay === delay).forEach((item) => item.callback());
  return { input, detector, field, event, tick, sent, listeners };
}

test("AI 延迟插入换行时不会在 40 毫秒提前保存发送", () => {
  const h = setup();
  h.detector.watchEnter(h.event, h.input, h.field);
  h.tick(40);
  assert.equal(h.sent.length, 0);
  h.input.text += "\n";
  h.listeners.get("input")({ inputType: "insertParagraph" });
  h.input.text = "";
  h.tick(140);
  h.tick(900);
  assert.equal(h.sent.length, 0);
  assert.equal(h.listeners.size, 0);
});

test("输入框切换或页面移除不会虚构发送历史", () => {
  const h = setup();
  h.detector.watchEnter(h.event, h.input, h.field);
  h.input.isConnected = false;
  h.tick(40);
  h.tick(900);
  assert.equal(h.sent.length, 0);
  assert.equal(h.listeners.size, 0);
});

test("发送按钮右键和非主指针不会记录发送", () => {
  const h = setup();
  h.detector.handlePointerDown({ button: 2 }, h.input, h.field);
  h.detector.handlePointerDown({ button: 0, isPrimary: false }, h.input, h.field);
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
