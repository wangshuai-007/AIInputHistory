const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "pro-network.js"), "utf8");
function model() {
  const context = { URL, ArrayBuffer, Uint8Array, TextDecoder, Map, Set, Date, Promise };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.AIHProNetwork;
}
const payload = (object) => {
  const data = Buffer.from(JSON.stringify(object));
  return { raw: [{ bytes: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) }] };
};
const request = (id, model, mode, extra = {}) => ({
  requestId: id, method: "POST", url: "https://chatgpt.com/backend-api/f/conversation",
  initiator: "https://chatgpt.com", tabId: 42, timeStamp: Date.now(),
  requestBody: payload({
    action: "next", model, ...(mode ? { mode } : {}),
    messages: [{ author: { role: "user" }, content: {
      parts: ["PRIVATE_PROMPT_DO_NOT_RECORD"]
    } }],
    accessToken: "SECRET_NEVER_RECORD", user: { email: "hidden@private.invalid" },
    ...extra
  })
});

test("模型识别只依赖模型或模式字段，不泄露对话正文及认证信息", () => {
  const m = model();
  for (const [field, expected] of [
    ["gpt-6-pro", "gpt-6-pro"], ["gpt-5.6-pro", "gpt-5.6-pro"],
    ["gpt-5-6-pro", "gpt-5.6-pro"], ["pro", "pro"]
  ]) {
    const result = m.classifyPayload(request("1", field, null).requestBody);
    assert.equal(result.proModelId, expected);
    assert.equal(result.reason, "explicit-pro-request");
    assert.equal(result.requestModel, field);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|SECRET_|hidden@/);
  }
  const byMode = m.classifyPayload(request("2", "auto", "pro").requestBody);
  assert.equal(byMode.proModelId, "pro");
  assert.equal(byMode.requestMode, "pro");
  assert.equal(m.classifyPayload(request("3", "gpt-6", null,
    { reasoning: { mode: "pro" } }).requestBody).proModelId, "pro");
  assert.equal(m.classifyPayload(request("4", "gpt-6", null,
    { model_mode: "pro" }).requestBody).proModelId, "pro");
});

test("不把账户身份、普通模型、Auto 或非用户发送当作 Pro", () => {
  const m = model();
  for (const [name, req] of [
    ["auto", request("1", "auto")], ["standard", request("2", "gpt-6")],
    ["thinking", request("3", "gpt-6-thinking")],
    ["conflict", request("4", "gpt-6-pro", "standard")],
    ["no-pro-model", request("5", "gpt-6", "standard")],
    ["account-plan-pro", request("6", "auto", null, { plan_type: "pro" })],
    ["no-user", request("7", "gpt-6-pro", null, { messages: [{ author: { role: "assistant" } }] })],
    ["other-action", request("8", "gpt-6-pro", null, { action: "poll" })]
  ]) {
    assert.equal(m.classifyPayload(req.requestBody).proModelId, null, name);
  }
});

test("仅限 ChatGPT 自身发起的 POST 对话接口，不观察其他网络流量", () => {
  const m = model();
  assert.equal(m.isConversationPost(request("1", "pro")), true);
  assert.equal(m.isConversationPost({ ...request("1", "pro"),
    url: "https://chatgpt.com/backend-api/conversation" }), true);
  for (const overrides of [
    { method: "GET" }, { tabId: -1 },
    { url: "https://example.com/backend-api/f/conversation" },
    { url: "https://chatgpt.com/backend-api/conversation/uuid" },
    { url: "https://chatgpt.com/backend-api/sentinel/chat-requirements/prepare" },
    { initiator: "https://evil.example" }
  ]) assert.equal(m.isConversationPost({ ...request("2", "pro"), ...overrides }), false);
});

test("原始请求体只短暂解析，未识别和过大内容不写出", () => {
  const m = model();
  assert.equal(m.classifyPayload(undefined).reason, "body-unavailable");
  assert.equal(m.classifyPayload({ raw: [{ bytes: Buffer.from("NOT JSON").buffer.slice(0, 8) }] }).reason,
    "invalid-json");
  assert.equal(m.classifyPayload({ raw: [{ bytes: new ArrayBuffer(3 * 1024 * 1024) }] }).reason,
    "body-too-large");
  assert.equal(m.safeEnum("secret@example.com"), null);
  assert.equal(m.safeEnum("SECRET_BEARER_TOKEN"), null);
  assert.equal(m.safeEnum("gpt-6-pro"), "gpt-6-pro");
});

test("只有 HTTP 2xx 确认后才登记；失败、重复响应、开关关闭均不登记", async () => {
  const m = model();
  const callbacks = {};
  const mocks = {};
  for (const key of ["onBeforeRequest", "onResponseStarted", "onCompleted", "onErrorOccurred"]) {
    mocks[key] = { addListener(callback) { callbacks[key] = callback; } };
  }
  const counted = [], diagnostics = [];
  const observer = m.createObserver({
    webRequest: mocks, onAccepted: (req) => { counted.push(req); },
    onDiagnostic: (entry) => { diagnostics.push(entry); }
  });
  observer.setEnabled(true);
  callbacks.onBeforeRequest(request("first", "gpt-6-pro"));
  assert.equal(counted.length, 0);
  callbacks.onResponseStarted({ requestId: "first", statusCode: 200 });
  callbacks.onResponseStarted({ requestId: "first", statusCode: 200 });
  callbacks.onCompleted({ requestId: "first", statusCode: 200 });
  await observer.flush();
  assert.equal(counted.length, 1);
  assert.equal(counted[0].proModelId, "gpt-6-pro");
  assert.match(counted[0].requestId, /^network:first:\d+(?:\.\d+)?$/);
  assert.equal(observer.pendingSize(), 0);

  callbacks.onBeforeRequest(request("denied", "pro"));
  callbacks.onResponseStarted({ requestId: "denied", statusCode: 403 });
  await observer.flush();
  assert.equal(counted.length, 1);
  callbacks.onBeforeRequest(request("failed", "pro"));
  callbacks.onErrorOccurred({ requestId: "failed", error: "net::ERR_CONNECTION_RESET" });
  await observer.flush();
  assert.equal(counted.length, 1);
  callbacks.onBeforeRequest(request("ordinary", "gpt-6"));
  callbacks.onResponseStarted({ requestId: "ordinary", statusCode: 200 });
  await observer.flush();
  assert.equal(counted.length, 1);
  observer.setEnabled(false);
  callbacks.onBeforeRequest(request("disabled", "pro"));
  callbacks.onResponseStarted({ requestId: "disabled", statusCode: 200 });
  await observer.flush();
  assert.equal(counted.length, 1);
  assert.equal(observer.pendingSize(), 0);
  assert.ok(diagnostics.some((e) => e.stage === "pro-network-accepted"));
  assert.ok(diagnostics.some((e) => e.stage === "pro-network-rejected"));
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_PROMPT|SECRET_|hidden@|ERR_CONNECTION_RESET/);
});

function lifecycleObserver(options = {}) {
  const callbacks = {};
  const webRequest = Object.fromEntries([
    "onBeforeRequest", "onResponseStarted", "onCompleted", "onErrorOccurred"
  ].map((name) => [name, { addListener(fn) { callbacks[name] = fn; } }]));
  const observer = model().createObserver({ webRequest, ...options });
  return { callbacks, observer };
}

test("worker restart restores only sanitized pending metadata and counts once", async () => {
  let cache = [];
  const counted = [];
  const options = {
    loadEnabled: async () => true,
    loadPending: async () => structuredClone(cache),
    savePending: async (items) => { cache = structuredClone(items); },
    onAccepted: (item) => { counted.push(item); }
  };
  const first = lifecycleObserver(options);
  first.callbacks.onBeforeRequest(request("restart", "gpt-6-pro"));
  await first.observer.flush();
  assert.equal(cache.length, 1);
  assert.equal(counted.length, 0);
  assert.doesNotMatch(JSON.stringify(cache), /PRIVATE_PROMPT|SECRET_|hidden@|requestBody|content|accessToken/);
  const second = lifecycleObserver(options);
  second.callbacks.onResponseStarted({ requestId: "restart", statusCode: 200 });
  second.callbacks.onCompleted({ requestId: "restart", statusCode: 200 });
  await second.observer.flush();
  assert.equal(counted.length, 1);
  assert.equal(counted[0].proModelId, "gpt-6-pro");
  assert.equal(cache.length, 0);
});

test("disabled startup never parses request bodies and removes stale pending metadata", async () => {
  let reads = 0;
  let cache = [{ requestId: "old" }];
  const { callbacks, observer } = lifecycleObserver({
    loadEnabled: async () => false,
    loadPending: async () => cache,
    savePending: async (items) => { cache = items; },
    onAccepted: () => assert.fail("disabled observer must not count")
  });
  const item = request("disabled-startup", "gpt-6-pro");
  Object.defineProperty(item, "requestBody", { get() { reads++; throw new Error("must not read"); } });
  callbacks.onBeforeRequest(item);
  callbacks.onResponseStarted({ requestId: item.requestId, statusCode: 200 });
  await observer.flush();
  assert.equal(reads, 0);
  assert.equal(cache.length, 0);
});

test("live disabled setting wins over a stale enabled startup snapshot", async () => {
  let release;
  const { callbacks, observer } = lifecycleObserver({
    loadEnabled: () => new Promise((resolve) => { release = resolve; }),
    onAccepted: () => assert.fail("stale settings must not count")
  });
  callbacks.onBeforeRequest(request("startup-toggle", "pro"));
  observer.setEnabled(false);
  await Promise.resolve();
  release(true);
  await observer.flush();
  assert.equal(observer.isEnabled(), false);
  assert.equal(observer.pendingSize(), 0);
});

test("failed count persistence retries on completion without keeping a request body", async () => {
  let attempts = 0, counted = 0;
  const { callbacks, observer } = lifecycleObserver({
    loadEnabled: async () => true,
    onAccepted: async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient storage failure");
      counted++;
    }
  });
  callbacks.onBeforeRequest(request("retry-store", "gpt-6-pro"));
  callbacks.onResponseStarted({ requestId: "retry-store", statusCode: 200 });
  await observer.flush();
  assert.equal(observer.pendingSize(), 1);
  callbacks.onCompleted({ requestId: "retry-store", statusCode: 200 });
  await observer.flush();
  assert.equal(attempts, 2);
  assert.equal(counted, 1);
  assert.equal(observer.pendingSize(), 0);
});

test("pending metadata has a strict 150-request bound", async () => {
  const { callbacks, observer } = lifecycleObserver({ loadEnabled: async () => true });
  for (let i = 0; i < 152; i++) callbacks.onBeforeRequest(request("bounded-" + i, "pro"));
  await observer.flush();
  assert.equal(observer.pendingSize(), 150);
  observer.setEnabled(false);
  await observer.flush();
  assert.equal(observer.pendingSize(), 0);
});
