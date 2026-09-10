const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const notificationSource = fs.readFileSync(path.join(__dirname, "..", "src", "completion-notification.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function setup(config) {
  let listener;
  const notifications = [];
  const requests = [];
  const data = { aiInputHistorySettings: { language: "zh-CN", completionNotification: config } };
  const context = {
    URL, URLSearchParams, Date, crypto: { randomUUID: () => "id" }, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, text: async () => "" }; },
    chrome: {
      runtime: { lastError: null, onMessage: { addListener(value) { listener = value; } } },
      storage: { local: { get(key, callback) { callback({ [key]: data[key] }); } } },
      notifications: { create(id, options, callback) { notifications.push({ id, options }); callback(id); } }
    }
  };
  context.globalThis = context;
  context.importScripts = () => vm.runInNewContext(notificationSource, context);
  vm.runInNewContext(backgroundSource, context);
  const send = (message) => new Promise((resolve) => listener(message, { tab: { id: 1 } }, resolve));
  return { send, notifications, requests };
}

test("浏览器通知只包含截断后的问题摘要", async () => {
  const h = setup({ enabled: true, provider: "browser" });
  const result = await h.send({
    type: "AIH_REQUEST_COMPLETED",
    event: { promptText: "这是一个需要在回复完成之后发送系统通知的很长很长的问题内容用于验证省略", durationMs: 1200, completedAt: Date.now() }
  });
  assert.equal(result.ok, true);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].options.title, "ChatGPT 回复完成");
  assert.equal(h.notifications[0].options.message.endsWith("…"), true);
  assert.equal(h.requests.length, 0);
});

test("第三方通知由后台发送且未开启时不会发送", async () => {
  const h = setup({ enabled: true, provider: "ntfy", ntfyUrl: "https://ntfy.sh", ntfyTopic: "my-topic" });
  const result = await h.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "处理完成", completedAt: Date.now(), durationMs: 2000 } });
  assert.equal(result.ok, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "https://ntfy.sh/my-topic");
  assert.equal(h.requests[0].options.credentials, "omit");

  const disabled = setup({ enabled: false, provider: "ntfy", ntfyUrl: "https://ntfy.sh", ntfyTopic: "my-topic" });
  const skipped = await disabled.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "不会发送" } });
  assert.equal(skipped.skipped, true);
  assert.equal(disabled.requests.length, 0);
});
