const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const storeSource = fs.readFileSync(path.join(__dirname, "../src/history-store.js"), "utf8");
const queueSource = fs.readFileSync(path.join(__dirname, "../src/prompt-queue.js"), "utf8");

function setup(initial = {}) {
  const data = structuredClone(initial);
  const sandbox = {
    URL, setTimeout, clearTimeout, queueMicrotask,
    location: { hostname: "chatgpt.com", pathname: "/c/test" },
    document: { querySelector() { return null; }, querySelectorAll() { return []; } },
    chrome: { runtime: {}, storage: { local: {
      get(key, callback) { callback({ [key]: structuredClone(data[key]) }); },
      set(value, callback) { Object.assign(data, structuredClone(value)); callback(); }
    } } }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(storeSource, sandbox);
  sandbox.AIInputHistory.SiteProfiles = { forSite: (site) => /^(chatgpt\.com|chat\.openai\.com)$/i.test(site) ? { id: "chatgpt" } : null };
  vm.runInNewContext(queueSource, sandbox);
  return {
    store: new sandbox.AIInputHistory.HistoryStore(),
    model: sandbox.AIInputHistory.promptQueueModel,
    PromptQueue: sandbox.AIInputHistory.PromptQueue,
    namespace: sandbox.AIInputHistory,
    data
  };
}
test("排队消息按 FIFO 保存，并支持编辑和撤回", async () => {
  const { store } = setup();
  const first = await store.enqueuePrompt("chatgpt.com|/c/1", "第一条");
  const second = await store.enqueuePrompt("chatgpt.com|/c/1", "第二条");
  assert.deepEqual((await store.getPromptQueue("chatgpt.com|/c/1")).map((item) => item.text), ["第一条", "第二条"]);

  assert.equal(await store.updatePromptQueueItem("chatgpt.com|/c/1", first.id, "第一条已编辑"), true);
  assert.equal(await store.removePromptQueueItem("chatgpt.com|/c/1", second.id), true);
  assert.deepEqual((await store.getPromptQueue("chatgpt.com|/c/1")).map((item) => item.text), ["第一条已编辑"]);
});

test("单个会话最多保留 20 条排队消息", async () => {
  const { store } = setup();
  for (let index = 0; index < 20; index += 1) await store.enqueuePrompt("chatgpt.com|/c/limit", `消息 ${index}`);
  await assert.rejects(store.enqueuePrompt("chatgpt.com|/c/limit", "第 21 条"), /20/);
  assert.equal((await store.getPromptQueue("chatgpt.com|/c/limit")).length, 20);
});
test("新对话从临时路径切到正式会话 URL 时迁移队列且保持顺序", async () => {
  const { store, model } = setup();
  const first = await store.enqueuePrompt("chatgpt.com|/", "第一条");
  const second = await store.enqueuePrompt("chatgpt.com|/", "第二条");
  assert.equal(model.canAdoptQueueKey("chatgpt.com|/", "chatgpt.com|/c/abc"), true);

  const moved = await store.movePromptQueue("chatgpt.com|/", "chatgpt.com|/c/abc");
  assert.deepEqual(Array.from(moved, (item) => item.id), [first.id, second.id]);
  assert.equal((await store.getPromptQueue("chatgpt.com|/")).length, 0);
  assert.deepEqual((await store.getPromptQueue("chatgpt.com|/c/abc")).map((item) => item.text), ["第一条", "第二条"]);
});

test("空闲状态即使存在残留队列也直接发送，只有等待 GPT 回复时才排队", () => {
  const { store, PromptQueue, namespace } = setup();
  let active = false;
  namespace.requestTimingModel = { sampleChatGPT: () => ({ busy: false }) };
  const queue = new PromptQueue({ store, adapter: {}, getInput: () => null, isRequestActive: () => active });
  queue.items = [{ id: "old", text: "残留队列" }];
  assert.equal(queue.shouldQueue(), false);
  active = true;
  assert.equal(queue.shouldQueue(), true);
});

test("Queue 只对 ChatGPT 站点启用", () => {
  const { model } = setup();
  assert.equal(model.supportedSite("chatgpt.com"), true);
  assert.equal(model.supportedSite("chat.openai.com"), true);
  assert.equal(model.supportedSite("example.com"), false);
});


test("计时仍活跃但页面已经完成时，Queue 不应被旧计时状态卡住", () => {
  const { store, PromptQueue, namespace } = setup();
  let state = { busy: false, replies: [{ key: "old", complete: true }] };
  namespace.requestTimingModel = { sampleChatGPT: () => state };
  const queue = new PromptQueue({ store, adapter: {}, getInput: () => null, isRequestActive: () => true });
  assert.equal(queue.canDrain(), false, "未见过本轮 busy 时不能把旧完成按钮当成当前回复结束");
  state = { busy: true, replies: [{ key: "new", complete: false }] };
  assert.equal(queue.canDrain(), false);
  state = { busy: false, replies: [{ key: "new", complete: true }] };
  assert.equal(queue.canDrain(), true, "已经历 busy→完成后，即使计时状态尚未清除也应允许出队");
});

test("自动点击只记录发送尝试，确认页面消费后才真正移出 Queue", async () => {
  const { store, PromptQueue, namespace } = setup();
  namespace.requestTimingModel = { sampleChatGPT: () => ({ busy: false, replies: [] }) };
  const item = await store.enqueuePrompt("chatgpt.com|/c/test", "待自动发送");
  const queue = new PromptQueue({ store, adapter: {}, getInput: () => null, isRequestActive: () => false });
  queue.items = await store.getPromptQueue(queue.key);
  queue.dispatchingId = item.id;
  assert.equal(await queue.confirmRecordedSend("待自动发送"), true);
  assert.equal((await store.getPromptQueue(queue.key)).length, 1, "click 被记录不代表 ChatGPT 已真正接收");
  queue.autoDispatching = true;
  assert.equal(queue.suppressAutoDispatchRecord(), true, "后续自动重试不应重复写发送历史");
  queue.autoDispatching = false;
  await queue.finalizeDispatch(item.id);
  assert.equal((await store.getPromptQueue(queue.key)).length, 0);
});

test("超过两分钟的旧计时且页面已经完成时，不再阻塞直接发送和 Queue 出队", () => {
  const { store, PromptQueue, namespace } = setup();
  namespace.requestTimingModel = { sampleChatGPT: () => ({ busy: false, replies: [{ key: "done", complete: true }] }) };
  const queue = new PromptQueue({
    store, adapter: {}, getInput: () => null,
    isRequestActive: () => true,
    getRequestStartedAt: () => Date.now() - 121_000
  });
  assert.equal(queue.shouldQueue(), false, "旧异常计时不能继续把新输入强制排队");
  assert.equal(queue.canDrain(), true, "旧异常计时不能阻塞已有 Queue 自动出队");
});

test("异常发送超时会保留失败消息、释放发送锁并允许后续消息继续", async () => {
  const { store, PromptQueue, namespace } = setup();
  namespace.requestTimingModel = { sampleChatGPT: () => ({ busy: false, replies: [] }) };
  const first = await store.enqueuePrompt("chatgpt.com|/c/test", "异常消息");
  await store.enqueuePrompt("chatgpt.com|/c/test", "后续消息");
  let inputText = "异常消息";
  const input = { isConnected: true };
  const adapter = {
    getText: () => inputText,
    setText: (_input, value) => { inputText = value; }
  };
  const queue = new PromptQueue({ store, adapter, getInput: () => input, isRequestActive: () => false, dispatchTimeoutMs: 10 });
  queue.items = await store.getPromptQueue(queue.key);
  queue.dispatchingId = first.id;
  queue.dispatchText = first.text;
  queue.dispatchStartedAt = Date.now() - 20;
  queue.scheduleDrain = () => {};
  queue.render = () => {};
  queue.markDispatchFailed(input, first.id);
  assert.equal(queue.dispatchingId, "", "失败后必须释放 dispatchingId");
  assert.equal(queue.failedIds.has(first.id), true, "失败项应保留并标记为可手动重试");
  assert.equal(inputText, "", "失败时只清理由 Queue 自动填入的相同文本");
  assert.deepEqual((await store.getPromptQueue(queue.key)).map((item) => item.text), ["异常消息", "后续消息"], "失败消息不能被静默删除");
});

test("立即发送可绕过旧请求等待状态，直接启动指定 Queue 项", async () => {
  const { store, PromptQueue, namespace } = setup();
  namespace.requestTimingModel = { sampleChatGPT: () => ({ busy: false, replies: [{ complete: true }] }) };
  const item = await store.enqueuePrompt("chatgpt.com|/c/test", "立即发送我");
  let inputText = "";
  const input = { isConnected: true };
  const adapter = {
    getText: () => inputText,
    setText: (_input, value) => { inputText = value; },
    findComposer: () => input
  };
  const queue = new PromptQueue({ store, adapter, getInput: () => input, isRequestActive: () => true });
  queue.items = await store.getPromptQueue(queue.key);
  let dispatched = "";
  queue.render = () => {};
  queue.continueDispatch = (_input, id) => { dispatched = id; };
  assert.equal(await queue.sendNow(item.id), true);
  assert.equal(inputText, "立即发送我");
  assert.equal(dispatched, item.id, "立即发送按钮不应等待旧 RequestTiming 结束");
});