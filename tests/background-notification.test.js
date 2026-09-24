const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const notificationSource = fs.readFileSync(path.join(__dirname, "..", "src", "completion-notification.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function setup(config, fixedNow = null) {
  let listener;
  const notifications = [];
  const requests = [];
  const data = { aiInputHistorySettings: { language: "zh-CN", completionNotification: config } };
  const sessionData = {};
  const RuntimeDate = fixedNow == null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  const context = {
    URL, URLSearchParams, Date: RuntimeDate, crypto: { randomUUID: () => "id" }, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, text: async () => "" }; },
    chrome: {
      runtime: { lastError: null, onMessage: { addListener(value) { listener = value; } } },
      storage: {
        local: { get(key, callback) { callback({ [key]: data[key] }); }, set(value, callback) { Object.assign(data, value); callback?.(); } },
        session: { get(key, callback) { callback({ [key]: sessionData[key] }); }, set(value, callback) { Object.assign(sessionData, value); callback?.(); } }
      },
      notifications: { create(id, options, callback) { notifications.push({ id, options }); callback(id); } }
    }
  };
  context.globalThis = context;
  context.importScripts = () => vm.runInNewContext(notificationSource, context);
  vm.runInNewContext(backgroundSource, context);
  const send = (message, tabId = 1) => new Promise((resolve) => listener(message, { tab: { id: tabId } }, resolve));
  return { send, notifications, requests, sessionData, data, context };
}

test("浏览器通知只包含截断后的问题摘要", async () => {
  const h = setup({ enabled: true, provider: "browser" });
  const result = await h.send({
    type: "AIH_REQUEST_COMPLETED",
    event: { promptText: "这是一个需要在回复完成之后发送系统通知的很长很长的问题内容用于验证省略", durationMs: 21_000, completedAt: Date.now() }
  });
  assert.equal(result.ok, true);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].options.title, "ChatGPT 回复完成");
  assert.equal(h.notifications[0].options.message.endsWith("…"), true);
  assert.equal(h.requests.length, 0);
});

test("请求计时按会话 URL 保存，换标签页重新打开仍可读取和清除", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const state = { requestId: "request-one", site: "chatgpt.com", startedAt: Date.now(), path: "/c/one", known: ["old"], knownErrors: [], sawReply: false };
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state }, 1)).ok, true);
  const loaded = await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/one" }, 99);
  assert.equal(loaded.state.path, "/c/one");
  assert.equal(loaded.state.requestId, "request-one");
  assert.deepEqual(loaded.state.known, ["old"]);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/two" }, 99)).state, null);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_CLEAR", requestId: "request-one" }, 99)).ok, true);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/one" }, 1)).state, null);
});

test("第三方通知由后台发送且未开启时不会发送", async () => {
  const h = setup({ enabled: true, provider: "ntfy", ntfyUrl: "https://ntfy.sh", ntfyTopic: "my-topic" });
  const result = await h.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "处理完成", completedAt: Date.now(), durationMs: 21_000 } });
  assert.equal(result.ok, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "https://ntfy.sh/my-topic");
  assert.equal(h.requests[0].options.credentials, "omit");

  const disabled = setup({ enabled: false, provider: "ntfy", ntfyUrl: "https://ntfy.sh", ntfyTopic: "my-topic" });
  const skipped = await disabled.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "不会发送" } });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "disabled");
  assert.equal(disabled.requests.length, 0);
});

test("自动通知默认低于 20 秒跳过，达到阈值才发送", async () => {
  const h = setup({ enabled: true, provider: "browser" });
  const fast = await h.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "快速回复", durationMs: 19_999, completedAt: Date.now() } });
  assert.equal(fast.ok, true);
  assert.equal(fast.skipped, true);
  assert.equal(fast.reason, "below-min-duration");
  assert.equal(fast.minDurationSeconds, 20);
  assert.equal(h.notifications.length, 0);

  const threshold = await h.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "达到阈值", durationMs: 20_000, completedAt: Date.now() } });
  assert.equal(threshold.ok, true);
  assert.equal(h.notifications.length, 1);

  const custom = setup({ enabled: true, provider: "browser", minDurationSeconds: 30 });
  const customFast = await custom.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "自定义阈值以下", durationMs: 29_999, completedAt: Date.now() } });
  assert.equal(customFast.skipped, true);
  assert.equal(custom.notifications.length, 0);
  await custom.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "自定义阈值边界", durationMs: 30_000, completedAt: Date.now() } });
  assert.equal(custom.notifications.length, 1);
});

test("自动通知只在任一可用时间段内发送，并支持跨午夜", async () => {
  const noon = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const allowed = setup({ enabled: true, provider: "browser", minDurationSeconds: 0, availableTimes: [{ start: "08:00", end: "10:00" }, { start: "11:30", end: "13:00" }] }, noon);
  const sent = await allowed.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "午间通知", durationMs: 1000, completedAt: noon } });
  assert.equal(sent.ok, true);
  assert.equal(sent.withinAvailableTime, true);
  assert.equal(sent.availableTimeCount, 2);
  assert.equal(allowed.notifications.length, 1);

  const blocked = setup({ enabled: true, provider: "browser", minDurationSeconds: 0, availableTimes: [{ start: "13:00", end: "14:00" }] }, noon);
  const skipped = await blocked.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "不在时段", durationMs: 1000, completedAt: noon } });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "outside-available-time");
  assert.equal(skipped.localTime, "12:00");
  assert.equal(blocked.notifications.length, 0);

  const late = new Date(2026, 0, 2, 23, 30, 0).getTime();
  const overnight = setup({ enabled: true, provider: "browser", minDurationSeconds: 0, availableTimes: [{ start: "22:00", end: "02:00" }] }, late);
  const overnightSent = await overnight.send({ type: "AIH_REQUEST_COMPLETED", event: { promptText: "跨午夜", durationMs: 1000, completedAt: late } });
  assert.equal(overnightSent.ok, true);
  assert.equal(overnightSent.withinAvailableTime, true);
  assert.equal(overnight.notifications.length, 1);
});

test("测试通知绕过最低耗时和可用时间，但关闭总开关时仍拒绝发送", async () => {
  const noon = new Date(2026, 0, 2, 12, 0, 0).getTime();
  const h = setup({ enabled: true, provider: "browser", minDurationSeconds: 120, availableTimes: [{ start: "13:00", end: "14:00" }] }, noon);
  const sent = await h.send({ type: "AIH_NOTIFICATION_TEST" });
  assert.equal(sent.ok, true);
  assert.equal(h.notifications.length, 1);

  const disabled = setup({ enabled: false, provider: "browser", minDurationSeconds: 0 });
  const rejected = await disabled.send({ type: "AIH_NOTIFICATION_TEST" });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /尚未开启|尚未保存/);
  assert.equal(disabled.notifications.length, 0);
});

test("企业微信渠道只发 HTTP，不会创建浏览器系统通知，并留下脱敏日志", async () => {
  const h = setup({
    enabled: true, provider: "wecom", minDurationSeconds: 20,
    wecomWebhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=VERY_SECRET_KEY"
  });
  const result = await h.send({
    type: "AIH_REQUEST_COMPLETED",
    event: { promptText: "不应进入调试日志的问题正文", durationMs: 25_000, completedAt: Date.now(), pageUrl: "https://chatgpt.com/c/example" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, "wecom");
  assert.equal(result.deliveryKind, "http");
  assert.equal(h.requests.length, 1);
  assert.equal(h.notifications.length, 0);

  const logs = h.data.aiInputHistoryNotificationDebugLog;
  assert.ok(logs.some((entry) => entry.stage === "config-resolved" && entry.provider === "wecom"));
  assert.ok(logs.some((entry) => entry.stage === "http-send" && entry.provider === "wecom" && entry.endpointHost === "qyapi.weixin.qq.com"));
  assert.equal(logs.some((entry) => entry.stage === "browser-create"), false);
  const serialized = JSON.stringify(logs);
  assert.doesNotMatch(serialized, /VERY_SECRET_KEY|不应进入调试日志的问题正文/);
});

test("页面追加的通知调试日志只保留白名单字段", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const appended = await h.send({
    type: "AIH_NOTIFICATION_DEBUG_APPEND",
    entry: { stage: "completion-detected", enabled: true, page: "chatgpt.com/c/one", promptText: "secret prompt", webhook: "https://example.com/?token=secret" }
  });
  assert.equal(appended.ok, true);
  const result = await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" });
  assert.equal(result.ok, true);
  assert.equal(result.logs.at(-1).stage, "completion-detected");
  assert.equal(result.logs.at(-1).page, "chatgpt.com/c/one");
  assert.equal("promptText" in result.logs.at(-1), false);
  assert.equal("webhook" in result.logs.at(-1), false);
});
