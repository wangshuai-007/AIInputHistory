const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const notificationSource = fs.readFileSync(path.join(__dirname, "..", "src", "completion-notification.js"), "utf8");
const proNetworkSource = fs.readFileSync(path.join(__dirname, "..", "src", "pro-network.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

function setup(config, fixedNow = null) {
  let listener;
  const webRequestCallbacks = {};
  const storageListeners = [];
  const notifications = [];
  const requests = [];
  const data = { aiInputHistorySettings: { language: "zh-CN", completionNotification: config } };
  const sessionData = {};
  const RuntimeDate = fixedNow == null ? Date : class extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  const context = {
    URL, URLSearchParams, ArrayBuffer, Uint8Array, TextDecoder,
    Date: RuntimeDate, crypto: { randomUUID: () => "id" }, setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: true, status: 200, text: async () => "" }; },
    chrome: {
      runtime: { lastError: null, onMessage: { addListener(value) { listener = value; } } },
      storage: {
        onChanged: { addListener(fn) { storageListeners.push(fn); } },
        local: { get(key, callback) { callback({ [key]: data[key] }); },
          set(value, callback) {
            const changes = Object.fromEntries(Object.entries(value).map(([key, newValue]) =>
              [key, { oldValue: data[key], newValue }]));
            Object.assign(data, value);
            storageListeners.forEach((fn) => fn(changes, "local"));
            callback?.();
          } },
        session: { get(key, callback) { callback({ [key]: sessionData[key] }); }, set(value, callback) { Object.assign(sessionData, value); callback?.(); } }
      },
      notifications: { create(id, options, callback) { notifications.push({ id, options }); callback(id); } },
      webRequest: Object.fromEntries(["onBeforeRequest", "onResponseStarted",
        "onCompleted", "onErrorOccurred"].map((key) => [key, {
          addListener(fn) { webRequestCallbacks[key] = fn; }
        }]))
    }
  };
  context.globalThis = context;
  context.importScripts = (...files) => files.forEach((file) => vm.runInNewContext(
    file.endsWith("pro-network.js") ? proNetworkSource : notificationSource, context
  ));
  vm.runInNewContext(backgroundSource, context);
  const send = (message, tabId = 1, url = null) => new Promise((resolve) =>
    listener(message, { tab: { id: tabId, url }, url }, resolve));
  return { send, notifications, requests, sessionData, data, context,
    webRequestCallbacks, storageListeners };
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

test("多个 ChatGPT 会话 ID 独立保存，并支持相同 ID 的不同页面路径", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const at = Date.now();
  const one = { requestId: "request-one", site: "chatgpt.com", path: "/c/alpha", startedAt: at, known: [] };
  const two = { requestId: "request-two", site: "chatgpt.com", path: "/g/example/c/beta", startedAt: at + 1, known: [] };
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: one }, 1)).saved, true);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: two }, 2)).saved, true);
  assert.equal(Object.keys(h.data.aiInputHistoryActiveTimingByUrl).length, 2);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/project/abc/c/beta" }, 88)).state.requestId, "request-two");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/alpha" }, 1)).state.requestId, "request-one");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_FINALIZE", requestId: "request-one", status: "completed" }, 1)).claimed, true);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_FINALIZE", requestId: "request-one", status: "completed" }, 77)).claimed, false, "另一个标签页不应重复完成");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/beta" }, 2)).state.requestId, "request-two");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: one }, 77)).saved, false, "迟到的存档不能让已完成请求复活");
});

test("新对话 ID 尚未生成时不同标签页相互隔离，生成后迁移为固定会话 ID", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const at = Date.now();
  const a = { requestId: "pending-A", site: "chatgpt.com", path: "/", startedAt: at };
  const b = { requestId: "pending-B", site: "chatgpt.com", path: "/", startedAt: at + 1 };
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: a }, 11);
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: b }, 12);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/" }, 11)).state.requestId, "pending-A");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/" }, 12)).state.requestId, "pending-B");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/" }, 99)).state, null);
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: { ...a, path: "/c/new-id" } }, 11);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/new-id" }, 99)).state.requestId, "pending-A");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/" }, 11)).state, null);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/" }, 12)).state.requestId, "pending-B");
});

test("老版本按 URL 保存的计时可按会话 ID 恢复，旧请求不能覆盖后发请求", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const at = Date.now();
  const older = { requestId: "legacy", site: "chatgpt.com", path: "/g/gpt/c/reused", startedAt: at - 2000 };
  h.data.aiInputHistoryActiveTimingByUrl = { "chatgpt.com/g/gpt/c/reused": older };
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/reused" }, 4)).state.requestId, "legacy");
  const latest = { ...older, path: "/c/reused", requestId: "newer", startedAt: at };
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: latest }, 4)).saved, true);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: older }, 4)).saved, false);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/reused" }, 4)).state.requestId, "newer");
});

test("后台按会话 ID 暂停与恢复，扣除暂停时间并在侧边栏完成时持久化一次", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const startedAt = Date.now() - 25_000;
  h.data.aiInputHistoryState = { entries: [{ id: "entry-alpha", kind: "send", requestTiming: { status: "pending", startedAt } }] };
  const state = { site: "chatgpt.com", path: "/g/demo/c/alpha", conversationId: "alpha",
    requestId: "alpha-request", entryId: "entry-alpha", startedAt,
    pausedAt: null, pausedDurationMs: 0, pauseVersion: 0, sidebarUnreadCleared: true,
    completionContext: { promptText: "演示选择流程" } };
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state })).saved, true);
  const action = (status) => h.send({ type: "AIH_TIMING_SESSION_OBSERVE",
    status, site: "chatgpt.com", path: "/c/alpha", requestId: "alpha-request" });
  assert.equal((await action("paused")).applied, true);
  const key = "chatgpt.com::conversation:alpha";
  assert.ok(Number.isFinite(h.data.aiInputHistoryActiveTimingByUrl[key].pausedAt));
  h.data.aiInputHistoryActiveTimingByUrl[key].pausedAt -= 12_000;
  assert.equal((await action("running")).applied, true);
  assert.equal(h.data.aiInputHistoryActiveTimingByUrl[key].pausedAt, null);
  assert.ok(h.data.aiInputHistoryActiveTimingByUrl[key].pausedDurationMs >= 12_000);
  assert.equal((await action("completed")).claimed, true);
  const timing = h.data.aiInputHistoryState.entries[0].requestTiming;
  assert.equal(timing.status, "completed");
  assert.equal(timing.conversationId, "alpha");
  assert.equal(timing.confirmedFromSidebar, true);
  assert.ok(timing.durationMs >= 12_000 && timing.durationMs < 20_000, "暂停时间不能被计入");
  assert.equal(Object.keys(h.data.aiInputHistoryActiveTimingByUrl).length, 0, "侧边栏计时应移除");
  assert.equal((await action("completed")).claimed, undefined, "重复完成不会再次持久化");
});

test("已有未读状态不能提前结束旧会话，要求本次发送后先看到状态清除", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const state = { requestId: "unread-protect", site: "chatgpt.com", path: "/c/stale",
    startedAt: Date.now() - 5_000, pausedAt: null, sidebarUnreadCleared: false };
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state });
  const query = (status) => h.send({ type: "AIH_TIMING_SESSION_OBSERVE",
    status, site: "chatgpt.com", path: "/c/stale", requestId: "unread-protect" });
  assert.equal((await query("completed")).applied, false);
  assert.ok((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/stale" })).state);
  assert.equal((await query("unread-cleared")).applied, true);
  assert.equal((await query("completed")).claimed, true);
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/stale" })).state, null);
});

test("只有 ChatGPT 来源的可见页面额度信号允许入库，不保存原始提示与账户凭据", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const time = Date.now() + 3_600_000;
  const signal = { modelId: "gpt-6-pro", status: "remaining-shown",
    remaining: 14, resetAt: time, approximate: false, source: "chatgpt-visible-ui",
    promptText: "CANNOT_STORE_PROMPT", bearer: "CANNOT_STORE_TOKEN" };
  const message = { type: "AIH_PRO_QUOTA_OBSERVE", signal };
  assert.equal((await h.send(message, 1)).saved, false, "unknown sender should be rejected");
  assert.equal((await h.send(message, 1, "https://evil.example/c/abc")).saved, false, "other websites cannot inject quota signals");
  const output = await h.send(message, 3, "https://chatgpt.com/c/abc");
  assert.equal(output.saved, true);
  assert.equal(h.data.aiInputHistoryProQuotaStatus["gpt-6-pro"].remaining, 14);
  assert.equal(h.data.aiInputHistoryProQuotaStatus["gpt-6-pro"].resetAt, time);
  assert.equal(h.data.aiInputHistoryProQuotaStatus["gpt-6-pro"].observedAt > 0, true);
  assert.doesNotMatch(JSON.stringify(h.data.aiInputHistoryProQuotaStatus), /CANNOT_STORE/);
  assert.equal((await h.send(message, 3, "https://chatgpt.com/c/abc")).saved, false, "重复页面信号应被合并");
  const invalid = { type: "AIH_PRO_QUOTA_OBSERVE", signal: {
    modelId: "gpt-6-pro", source: "chatgpt-visible-ui", status: "remaining-shown", remaining: -1
  }};
  assert.equal((await h.send(invalid, 3, "https://chatgpt.com/c/abc")).saved, false);
});

test("Pro 计数仅在首次新请求计时入库时增加：刷新、重试、跨标签页只计一次", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  h.data.aiInputHistorySettings.trackProUsage = true;
  const start = Date.now() - 2200;
  const base = {
    requestId: "pro-request-one", site: "chatgpt.com", path: "/c/pro-one",
    startedAt: start, proModelId: "gpt-6-pro", proUsageEligible: true,
    completionContext: { promptText: "不存储提示词在 Pro 用量统计里" }
  };
  const save = (state, tab = 1) => h.send({ type: "AIH_TIMING_SESSION_SAVE", state }, tab);
  assert.equal((await save(base)).saved, true);
  const data = h.data.aiInputHistoryProUsage;
  assert.equal(data.models["gpt-6-pro"].total, 1);
  assert.equal(Object.keys(data.requestIds).length, 1);
  assert.equal(data.requestIds[base.requestId].model, "gpt-6-pro");
  await Promise.all([save(base, 2), save({ ...base, path: "/g/team/c/pro-one" }, 3)]);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1, "多标签页不能累加同一个请求");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/pro-one" })).state.requestId, base.requestId);
  await save({ ...base, proUsageEligible: false, pausedAt: start + 500, pauseVersion: start + 500 });
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1, "恢复后保存暂停状态不能增加次数");
  await h.send({ type: "AIH_TIMING_SESSION_FINALIZE", site: "chatgpt.com", path: "/c/pro-one",
    requestId: base.requestId, status: "completed" });
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1, "结束也不能增加次数");
  assert.equal((await save({ ...base, proUsageEligible: true })).saved, false, "完成后的旧请求不能重新出现");
  assert.ok(h.data.aiInputHistoryProUsage, "NETWORK TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1);
  const newer = { ...base, requestId: "pro-request-two", startedAt: Date.now(), proModelId: "gpt-5.6-pro",
    path: "/c/pro-two" };
  assert.equal((await save(newer)).saved, true);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-5.6-pro"].total, 1);
  assert.ok(h.data.aiInputHistoryProUsage, "NETWORK TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1);
  assert.equal(JSON.stringify(h.data.aiInputHistoryProUsage).includes("不存储提示词"), false, "只保存请求 ID、日期、模型，不保存问题");
  const log = h.data.aiInputHistoryNotificationDebugLog.filter((entry) => entry.stage === "pro-usage-counted");
  assert.equal(log.length, 2, "只记录两次新 Pro 计数事件");
});

test("重置仅清空本地 Pro 次数，保留请求 ID 防止刷新和旧请求补计", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  h.data.aiInputHistorySettings.trackProUsage = true;
  const first = { requestId: "reset-old-pro", site: "chatgpt.com", path: "/c/reset-pro",
    proModelId: "gpt-6-pro", proUsageEligible: true, startedAt: Date.now() - 1000 };
  const save = (state, tab = 1) => h.send({ type: "AIH_TIMING_SESSION_SAVE", state }, tab);
  assert.equal((await save(first)).saved, true);
  assert.ok(h.data.aiInputHistoryProUsage, "NETWORK TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1);
  const output = await h.send({ type: "AIH_PRO_USAGE_RESET" });
  assert.equal(output.ok, true);
  assert.ok(Number.isFinite(output.resetAt));
  const month = new Date(output.resetAt);
  const monthKey = month.getFullYear() + "-" + String(month.getMonth() + 1).padStart(2, "0");
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].months[monthKey], 0);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1, "累计历史不清空");
  assert.ok(h.data.aiInputHistoryProUsage.requestIds[first.requestId]);
  assert.equal(h.data.aiInputHistoryProUsage.monthResetAt, output.resetAt);
  assert.equal((await save(first, 2)).saved, true, "计时同步仍应成功");
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].months[monthKey], 0,
    "刷新不能重新计入已清零的旧请求");
  const delayed = { ...first, requestId: "delayed-from-before-reset", path: "/c/delayed" };
  await save(delayed, 3);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].months[monthKey], 0,
    "重置前开始但迟到的请求也不应污染新统计");
  const next = { ...first, requestId: "reset-new-pro", startedAt: output.resetAt + 2000,
    path: "/c/reset-new" };
  assert.equal((await save(next)).saved, true);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 2);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].months[monthKey], 1);
  assert.ok(h.data.aiInputHistoryNotificationDebugLog.some((x) => x.stage === "pro-usage-local-reset"));
});

test("重置和新请求并发进入时按同一个后台队列串行执行", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  h.data.aiInputHistorySettings.trackProUsage = true;
  const first = h.send({ type: "AIH_TIMING_SESSION_SAVE", state: {
    requestId: "concurrent-reset-pro", site: "chatgpt.com", path: "/c/concurrent",
    proModelId: "pro", proUsageEligible: true, startedAt: Date.now() - 500
  } });
  const reset = h.send({ type: "AIH_PRO_USAGE_RESET" });
  const [saved, cleared] = await Promise.all([first, reset]);
  assert.equal(saved.saved, true);
  assert.equal(cleared.ok, true);
  assert.ok(h.data.aiInputHistoryProUsage, "MODE TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models.pro.total, 1);
  const at = new Date();
  const month = at.getFullYear() + "-" + String(at.getMonth() + 1).padStart(2, "0");
  assert.equal(h.data.aiInputHistoryProUsage.models.pro.months[month], 0);
  assert.ok(h.data.aiInputHistoryProUsage.requestIds["concurrent-reset-pro"]);
});
test("只有有效 ChatGPT Pro 开启计时的新请求才记录用量", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const at = Date.now();
  const cases = [
    { id: "normal", proModelId: null, proUsageEligible: true },
    { id: "not-tracking", proModelId: "gpt-6-pro", proUsageEligible: false },
    { id: "unknown-pro", proModelId: "gpt-6-thinking", proUsageEligible: true },
    { id: "not-chatgpt", proModelId: "gpt-6-pro", proUsageEligible: true, site: "other.example" },
    { id: "not-new", proModelId: "pro", proUsageEligible: undefined }
  ];
  for (const entry of cases) {
    const state = { requestId: entry.id, site: entry.site || "chatgpt.com",
      path: "/c/" + entry.id, startedAt: at, ...entry };
    assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state })).saved, true);
  }
  assert.equal(h.data.aiInputHistoryProUsage, undefined, "普通模式、无效模型、未开启追踪一律不计数");
});

test("Pro 统计与普通发送统计独立，按开始时间归入正确日期", async () => {
  const monday = new Date(2026, 9, 19, 22).getTime();
  const tuesday = new Date(2026, 9, 20, 8).getTime();
  const h = setup({ enabled: false, provider: "browser" });
  h.data.aiInputHistorySettings.trackProUsage = true;
  for (const [at, id] of [[monday, "a"], [tuesday, "b"], [tuesday, "c"]]) {
    // Keep timestamps fresh for the timer TTL when tests execute long after Oct 2026.
    const now = Date.now();
    await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: {
      requestId: "pro-date-" + id, site: "chatgpt.com",
      path: "/c/dates-" + id, startedAt: now - (tuesday - at), proModelId: "pro",
      proUsageEligible: true
    } });
  }
  const bucket = h.data.aiInputHistoryProUsage.models.pro;
  assert.equal(bucket.total, 3);
  assert.equal(Object.values(bucket.days).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.values(bucket.weeks).reduce((a, b) => a + b, 0), 3);
  assert.equal(Object.values(bucket.months).reduce((a, b) => a + b, 0), 3);
  assert.equal(h.data.aiInputHistoryConversationStats, undefined);
});
test("手动右键暂停持久化，自动运行状态不可覆盖，右键恢复时扣除等待时间", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const state = {
    requestId: "manual-flag", site: "chatgpt.com", path: "/c/manual",
    startedAt: Date.now() - 12000, pausedAt: null,
    pausedDurationMs: 0, pauseVersion: 0, sidebarUnreadCleared: true
  };
  const msg = (status) => h.send({
    type: "AIH_TIMING_SESSION_OBSERVE", site: "chatgpt.com",
    path: "/c/manual", requestId: "manual-flag", status
  }, 4);
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state }, 4);
  assert.equal((await msg("manual-paused")).manualPause, true);
  let snapshot = (await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).activeSessions[0];
  assert.equal(snapshot.status, "paused");
  assert.equal(snapshot.manualPause, true);
  assert.equal((await msg("running")).applied, false, "自动 running 不可取消人工暂停");
  // Older tab writes cannot replace the newer paused state.
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state }, 8);
  snapshot = (await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).activeSessions[0];
  assert.equal(snapshot.manualPause, true);
  assert.ok(Number.isFinite(snapshot.pausedAt));
  const key = "chatgpt.com::conversation:manual";
  h.data.aiInputHistoryActiveTimingByUrl[key].pausedAt -= 4500;
  assert.equal((await msg("manual-running")).manualPause, false);
  snapshot = (await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).activeSessions[0];
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.manualPause, false);
  assert.ok(snapshot.pausedDurationMs >= 4500);
  const logs = (await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).logs;
  assert.equal(logs.filter((event) => event.reason === "manual-right-click" && event.stage === "timing-paused").length, 1);
  assert.equal(logs.filter((event) => event.reason === "manual-right-click" && event.stage === "timing-resumed").length, 1);
});

test("本机和侧边栏暂停恢复都留下可按会话 ID 关联的持久日志", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const now = Date.now();
  const initial = {
    requestId: "logging-session-A", site: "chatgpt.com", path: "/c/session-A",
    startedAt: now - 12_000, entryId: "entry-A", pausedAt: null,
    pausedDurationMs: 0, pauseVersion: 0,
    sidebarUnreadCleared: true, completionContext: { promptText: "不应记录这段敏感问题" }
  };
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: initial }, 11);
  const paused = { ...initial, pausedAt: now, pauseVersion: now + 1, lastTransitionReason: "selection" };
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: paused }, 11);
  const resumed = {
    ...paused, pausedAt: null, pausedDurationMs: 1800, pauseVersion: now + 2,
    lastTransitionReason: "selection"
  };
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: resumed }, 11);
  await h.send({ type: "AIH_TIMING_SESSION_OBSERVE", requestId: initial.requestId,
    site: initial.site, path: initial.path, status: "paused" }, 22);
  await h.send({ type: "AIH_TIMING_SESSION_OBSERVE", requestId: initial.requestId,
    site: initial.site, path: initial.path, status: "running" }, 22);
  await h.send({ type: "AIH_TIMING_SESSION_FINALIZE", requestId: initial.requestId,
    site: initial.site, path: initial.path, status: "completed" }, 11);
  const { logs, activeSessions } = await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" });
  assert.equal(activeSessions.length, 0);
  const relevant = logs.filter((item) => item.requestId === initial.requestId);
  const stages = relevant.map((item) => item.stage);
  assert.equal(stages.filter((value) => value === "timing-started").length, 1);
  assert.equal(stages.filter((value) => value === "timing-paused").length, 2, "页面一次、侧边栏一次");
  assert.equal(stages.filter((value) => value === "timing-resumed").length, 2);
  assert.equal(stages.filter((value) => value === "timing-finished").length, 1);
  assert.equal(relevant.every((entry) => entry.conversationId === "session-A"), true);
  const contentPause = relevant.find((entry) => entry.stage === "timing-paused" && entry.source === "content");
  assert.equal(contentPause.reason, "selection");
  assert.equal(contentPause.sourceTabId, 11);
  const contentResume = relevant.find((entry) => entry.stage === "timing-resumed" && entry.source === "content");
  assert.equal(contentResume.pauseDeltaMs, 1800);
  assert.equal(contentResume.pausedDurationMs, 1800);
  const sidebarPause = relevant.find((entry) => entry.stage === "timing-paused" && entry.source === "sidebar");
  assert.equal(sidebarPause.sourceTabId, 22);
  assert.equal(JSON.stringify(logs).includes("不应记录这段敏感问题"), false, "不能记录问题正文");
  assert.ok(relevant.every((entry) => typeof entry.at === "number"));
});

test("诊断快照包含运行/暂停状态但不泄漏提问和完成通知凭据", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const state = {
    requestId: "safe-snapshot", site: "chatgpt.com", path: "/project/abc/c/preview",
    startedAt: Date.now() - 10_000, pausedAt: Date.now() - 4000,
    pausedDurationMs: 1000, pauseVersion: 12, entryId: "entry-1",
    completionContext: { promptText: "SECRET_PROMPT_DO_NOT_EXPORT",
      webhook: "SECRET_WEBHOOK_DO_NOT_EXPORT" }
  };
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state });
  const output = await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" });
  assert.equal(output.activeSessions.length, 1);
  const snapshot = output.activeSessions[0];
  assert.equal(snapshot.conversationId, "preview");
  assert.equal(snapshot.status, "paused");
  assert.equal(snapshot.entryLinked, true);
  assert.ok(snapshot.elapsedMs < 10_000);
  assert.doesNotMatch(JSON.stringify(output), /SECRET_PROMPT_DO_NOT_EXPORT|SECRET_WEBHOOK_DO_NOT_EXPORT/);
  assert.equal("completionContext" in snapshot, false);
});

test("计时诊断仅存储白名单字段，并有 500 条环形上限", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const privateText = "PRIVATE_PROMPT_EXAMPLE";
  const result = await h.send({ type: "AIH_NOTIFICATION_DEBUG_APPEND", entry: {
    stage: "timing-paused", requestId: "bounded", conversationId: "alpha",
    source: "sidebar", reason: "waiting-for-input", elapsedMs: 1200,
    promptText: privateText, responseText: privateText, webhook: privateText
  } });
  assert.equal(result.ok, true);
  let logs = (await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).logs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].conversationId, "alpha");
  assert.equal(logs[0].elapsedMs, 1200);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE_PROMPT_EXAMPLE/);
  for (let i = 0; i < 507; i++) {
    await h.send({ type: "AIH_NOTIFICATION_DEBUG_APPEND",
      entry: { stage: "timing-diagnostic-test", durationMs: i } });
  }
  logs = (await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).logs;
  assert.equal(logs.length, 500);
  assert.equal(logs.at(-1).durationMs, 506);
  assert.equal(logs[0].durationMs, 7);
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

test("ChatGPT 计时暂缓的诊断日志可持久读取，且不会写入聊天正文", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const result = await h.send({
    type: "AIH_NOTIFICATION_DEBUG_APPEND",
    entry: { stage: "timing-finish-deferred", type: "completed", reason: "composer-stop-icon",
      detectionTrigger: "mutation", durationMs: 4900, page: "chatgpt.com",
      promptText: "private prompt", responseText: "private reply" }
  });
  assert.equal(result.ok, true);
  const logs = (await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).logs;
  assert.equal(logs.at(-1).stage, "timing-finish-deferred");
  assert.equal(logs.at(-1).reason, "composer-stop-icon");
  assert.equal(logs.at(-1).durationMs, 4900);
  assert.equal(logs.at(-1).detectionTrigger, "mutation");
  assert.doesNotMatch(JSON.stringify(logs), /private prompt|private reply/);
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

test("GPT 当前标签页仍在生成时，旧侧边栏未读完成标记不能提前清除计时", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const at = Date.now();
  const state = {
    requestId: "busy-heartbeat", site: "chatgpt.com", path: "/c/busy-heartbeat",
    startedAt: at - 4000, lastBusyAt: at, pausedAt: null,
    pausedDurationMs: 0, pauseVersion: 0, sidebarUnreadCleared: true
  };
  const save = await h.send({ type: "AIH_TIMING_SESSION_SAVE", state }, 10);
  assert.equal(save.saved, true);
  const observe = () => h.send({ type: "AIH_TIMING_SESSION_OBSERVE",
    requestId: state.requestId, site: state.site, path: state.path,
    status: "completed" }, 22);
  const refused = await observe();
  assert.equal(refused.applied, false);
  assert.equal(refused.reason, "generation-still-observed");
  const key = "chatgpt.com::conversation:busy-heartbeat";
  assert.ok(h.data.aiInputHistoryActiveTimingByUrl[key]);
  assert.equal(h.data.aiInputHistoryActiveTimingByUrl[key].requestId, state.requestId);
  assert.ok(h.data.aiInputHistoryNotificationDebugLog.some((event) =>
    event.stage === "timing-sidebar-completion-deferred" && event.reason === "recent-generation-heartbeat"));
  h.data.aiInputHistoryActiveTimingByUrl[key].lastBusyAt = at - 20_000;
  const completed = await observe();
  assert.equal(completed.claimed, true);
  assert.equal(h.data.aiInputHistoryActiveTimingByUrl[key], undefined);
});


test("Pro 已确认发送即独立计一次，计时 SAVE 失败或关闭均不能漏计；同请求去重", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  h.data.aiInputHistorySettings.trackProUsage = true;
  const at = Date.now();
  const usage = {
    site: "chatgpt.com", requestId: "confirmed-independent-pro",
    startedAt: at, proModelId: "gpt-6-pro"
  };
  const count = () => h.send({ type: "AIH_PRO_USAGE_RECORD", usage }, 7, "https://chatgpt.com/c/alpha");
  const first = await count();
  assert.equal(first.ok, true);
  assert.equal(first.counted, true);
  assert.ok(h.data.aiInputHistoryProUsage, "NETWORK TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1);
  assert.equal((await count()).counted, false, "刷新和重复发送不能累加");
  assert.ok(h.data.aiInputHistoryProUsage, "NETWORK TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1);
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: {
    ...usage, path: "/c/alpha", proUsageEligible: true
  } }, 7);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1,
    "旧计时器计数来源和新确认发送来源复用请求 ID");
  assert.ok(h.data.aiInputHistoryNotificationDebugLog.some((x) =>
    x.stage === "pro-usage-counted" && x.reason === "confirmed-send"));
});

test("独立 Pro 计数拒绝未授权域、关闭开关、非 Pro 及被重置的旧请求", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  h.data.aiInputHistorySettings.trackProUsage = false;
  const now = Date.now();
  const usage = { site: "chatgpt.com", requestId: "refuse-first",
    proModelId: "pro", startedAt: now };
  const send = (state, url = "https://chatgpt.com/c/example") =>
    h.send({ type: "AIH_PRO_USAGE_RECORD", usage: state }, 5, url);
  assert.equal((await send(usage)).reason, "counter-disabled");
  h.data.aiInputHistorySettings.trackProUsage = true;
  assert.equal((await send(usage, "https://example.com/")).reason, "sender-host-mismatch");
  assert.equal((await send({ ...usage, proModelId: "gpt-6-instant" })).counted, false);
  assert.equal((await send(usage)).counted, true);
  const reset = await h.send({ type: "AIH_PRO_USAGE_RESET" });
  assert.equal(reset.ok, true);
  assert.equal((await send({ ...usage, requestId: "old-late-pro" })).counted, false);
  assert.equal((await send({ ...usage, requestId: "newer-pro", startedAt: reset.resetAt + 500 })).counted, true);
  const month = new Date(reset.resetAt);
  const k = month.getFullYear() + "-" + String(month.getMonth() + 1).padStart(2, "0");
  assert.equal(h.data.aiInputHistoryProUsage.models.pro.months[k], 1);
  assert.equal(h.data.aiInputHistoryProUsage.models.pro.total, 2);
});


test("Business 席位诊断字段可保存导出，但原始账号与登录凭据永不进入日志", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  const result = await h.send({ type: "AIH_NOTIFICATION_DEBUG_APPEND", entry: {
    stage: "pro-account-plan-read", source: "chatgpt-account-list",
    reason: "seat-type-unrecognized", status: "ok",
    accountPlan: "business-unverified", seatField: "seat_type",
    seatTypeCode: "default", seatValueKind: "string",
    seatMatchedBy: "user-id", seatFieldKeys: "seat_type,membership",
    seatRecordCount: 2, seatMapping: "legacy-default-as-standard",
    userId: "SECRET_USER_ID", email: "secret@example.invalid",
    accessToken: "SECRET_TOKEN", rawSeat: { secret: "PRIVATE_RAW_SEAT" },
    session: { accessToken: "MORE_SECRET" }
  } });
  assert.equal(result.ok, true);
  const { logs } = await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" });
  assert.equal(logs.length, 1);
  const entry = logs[0];
  assert.equal(entry.stage, "pro-account-plan-read");
  assert.equal(entry.reason, "seat-type-unrecognized");
  assert.equal(entry.seatTypeCode, "default");
  assert.equal(entry.seatField, "seat_type");
  assert.equal(entry.seatValueKind, "string");
  assert.equal(entry.seatMatchedBy, "user-id");
  assert.equal(entry.seatFieldKeys, "seat_type,membership");
  assert.equal(entry.seatRecordCount, 2);
  assert.equal(entry.seatMapping, "legacy-default-as-standard");
  assert.equal(entry.accountPlan, "business-unverified");
  assert.doesNotMatch(JSON.stringify(logs),
    /SECRET_USER_ID|secret@example|SECRET_TOKEN|PRIVATE_RAW|MORE_SECRET|rawSeat|accessToken|userId/i);
});


test("网络请求 Pro 计数和 DOM 计数共用后台去重，不按一个问题扣两次", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  await new Promise((resolve) => h.context.chrome.storage.local.set({
    aiInputHistorySettings: { ...h.data.aiInputHistorySettings, trackProUsage: true }
  }, resolve));
  const { onBeforeRequest, onResponseStarted, onCompleted } = h.webRequestCallbacks;
  assert.equal(typeof onBeforeRequest, "function");
  assert.equal(typeof onResponseStarted, "function");
  const at = Date.now();
  const make = (id, tabId, model = "gpt-6-pro", timeStamp = at) => {
    const raw = Buffer.from(JSON.stringify({
      action: "next", model,
      messages: [{ author: { role: "user" },
        content: { parts: ["SENSITIVE_PROMPT_NOT_FOR_LOGS"] } }],
      accessToken: "DO_NOT_KEEP_THIS_SECRET",
      cookie: "COOKIE_VALUE_NOT_FOR_LOGS"
    }));
    return { requestId: id, tabId, method: "POST",
      url: "https://chatgpt.com/backend-api/f/conversation",
      initiator: "https://chatgpt.com", timeStamp,
      requestBody: { raw: [{ bytes: raw.buffer.slice(raw.byteOffset,
        raw.byteOffset + raw.byteLength) }] } };
  };
  onBeforeRequest(make("web-accepted", 8));
  onResponseStarted({ requestId: "web-accepted", statusCode: 200 });
  onCompleted({ requestId: "web-accepted", statusCode: 200 });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  };
  await flush();
  assert.ok(h.data.aiInputHistoryProUsage, "NETWORK TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1);

  const duplicate = await h.send({ type: "AIH_PRO_USAGE_RECORD", usage: {
    site: "chatgpt.com", startedAt: at + 100,
    proModelId: "gpt-6-pro", requestId: "dom-duplicate"
  } }, 8, "https://chatgpt.com/c/conversation");
  assert.equal(duplicate.counted, false);
  assert.ok(h.data.aiInputHistoryProUsage, "NETWORK TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 1);

  const otherTab = await h.send({ type: "AIH_PRO_USAGE_RECORD", usage: {
    site: "chatgpt.com", startedAt: at + 150,
    proModelId: "gpt-6-pro", requestId: "other-tab-legitimate"
  } }, 9, "https://chatgpt.com/c/conversation");
  assert.equal(otherTab.counted, true);
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 2);

  const domFirst = await h.send({ type: "AIH_PRO_USAGE_RECORD", usage: {
    site: "chatgpt.com", startedAt: at + 10_000,
    proModelId: "pro", requestId: "dom-first"
  } }, 8, "https://chatgpt.com/c/conversation");
  assert.equal(domFirst.counted, true);
  onBeforeRequest(make("web-after-dom", 8, "gpt-6-pro", at + 10_200));
  onResponseStarted({ requestId: "web-after-dom", statusCode: 200 });
  await flush();
  assert.equal(h.data.aiInputHistoryProUsage.models["gpt-6-pro"].total, 2,
    "A later network signal must not count the same send again");
  assert.ok(h.data.aiInputHistoryProUsage, "MODE TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models.pro.total, 1);
  const rows = h.data.aiInputHistoryNotificationDebugLog || [];
  assert.ok(rows.some((x) => x.stage === "pro-network-accepted" && x.requestModel === "gpt-6-pro"));
  assert.ok(rows.some((x) => x.stage === "pro-network-deduplicated"));
  assert.doesNotMatch(JSON.stringify(rows),
    /SENSITIVE_PROMPT_NOT_FOR_LOGS|DO_NOT_KEEP_THIS_SECRET|COOKIE_VALUE_NOT_FOR_LOGS/);
});

test("网络模式计数需要明确 Pro 和成功响应，禁用时不读取请求体", async () => {
  const h = setup({ enabled: false, provider: "browser" });
  await new Promise((r) => h.context.chrome.storage.local.set({
    aiInputHistorySettings: { ...h.data.aiInputHistorySettings, trackProUsage: true }
  }, r));
  const make = (id, model, mode) => {
    const raw = Buffer.from(JSON.stringify({
      action: "next", model, mode, messages: [{
        author: { role: "user" }, content: { parts: ["PRIVATE_MESSAGE"] }
      }]
    }));
    return { requestId: id, tabId: 100, method: "POST",
      url: "https://chatgpt.com/backend-api/f/conversation",
      initiator: "https://chatgpt.com", timeStamp: Date.now(),
      requestBody: { raw: [{ bytes: raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) }] } };
  };
  const e = h.webRequestCallbacks;
  e.onBeforeRequest(make("auto", "auto", "standard"));
  e.onResponseStarted({ requestId: "auto", statusCode: 200 });
  e.onBeforeRequest(make("failed-pro", "auto", "pro"));
  e.onResponseStarted({ requestId: "failed-pro", statusCode: 400 });
  e.onBeforeRequest(make("mode-pro", "gpt-6", "pro"));
  e.onResponseStarted({ requestId: "mode-pro", statusCode: 200 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(h.data.aiInputHistoryProUsage, "MODE TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models.pro.total, 1);
  await new Promise((r) => h.context.chrome.storage.local.set({
    aiInputHistorySettings: { ...h.data.aiInputHistorySettings, trackProUsage: false }
  }, r));
  e.onBeforeRequest(make("off", "gpt-6-pro", null));
  e.onResponseStarted({ requestId: "off", statusCode: 200 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(h.data.aiInputHistoryProUsage, "MODE TRACE "+JSON.stringify((h.data.aiInputHistoryNotificationDebugLog||[]).slice(-10)));
  assert.equal(h.data.aiInputHistoryProUsage.models.pro.total, 1);
  const diagnostics = h.data.aiInputHistoryNotificationDebugLog || [];
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_MESSAGE/);
  assert.ok(diagnostics.some((entry) => entry.stage === "pro-network-accepted"
    && entry.requestMode === "pro"));
});
