const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const storeSource = fs.readFileSync(path.join(__dirname, "..", "src", "history-store.js"), "utf8");

function createRuntime() {
  let listener;
  let nextId = 0;
  const context = {
    chrome: { runtime: { onMessage: { addListener(value) { listener = value; } } } },
    crypto: { randomUUID: () => `token-${nextId += 1}` },
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(source, context);
  return (message, tabId = 1) => new Promise((resolve) => {
    const asyncResponse = listener(message, { tab: { id: tabId } }, resolve);
    if (asyncResponse === false && message.type !== "AIH_STORAGE_LOCK_RELEASE") resolve(undefined);
  });
}

test("多个窗口的本地存储写入会按顺序获得全局锁", async () => {
  const sendMessage = createRuntime();
  const first = await sendMessage({ type: "AIH_STORAGE_LOCK_ACQUIRE" }, 11);
  let secondGranted = false;
  const secondPromise = sendMessage({ type: "AIH_STORAGE_LOCK_ACQUIRE" }, 22)
    .then((lock) => { secondGranted = true; return lock; });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondGranted, false);
  assert.equal((await sendMessage({ type: "AIH_STORAGE_LOCK_RELEASE", token: first.token })).released, true);

  const second = await secondPromise;
  assert.notEqual(second.token, first.token);
  assert.equal(second.senderId, 22);
  assert.equal((await sendMessage({ type: "AIH_STORAGE_LOCK_RELEASE", token: second.token })).released, true);
});

test("错误令牌不能释放其他窗口持有的锁", async () => {
  const sendMessage = createRuntime();
  const lock = await sendMessage({ type: "AIH_STORAGE_LOCK_ACQUIRE" });
  assert.equal((await sendMessage({ type: "AIH_STORAGE_LOCK_RELEASE", token: "wrong" })).released, false);
  assert.equal((await sendMessage({ type: "AIH_STORAGE_LOCK_RELEASE", token: lock.token })).released, true);
});

test("并发记录不同网站时不会互相覆盖", async () => {
  let listener;
  let nextId = 0;
  const data = {};
  const runtime = {
    lastError: null,
    onMessage: { addListener(value) { listener = value; } },
    sendMessage(message, callback) { listener(message, { tab: { id: 1 } }, callback); }
  };
  const context = {
    chrome: { runtime, storage: { local: {
      get(key, callback) { setTimeout(() => callback({ [key]: data[key] }), 5); },
      set(value, callback) { setTimeout(() => { Object.assign(data, value); callback(); }, 5); }
    } } },
    crypto: { randomUUID: () => `token-${nextId += 1}` },
    URL,
    setTimeout,
    clearTimeout
  };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  vm.runInNewContext(storeSource, context);

  const firstStore = new context.AIInputHistory.HistoryStore();
  const secondStore = new context.AIInputHistory.HistoryStore();
  await Promise.all([
    firstStore.addEntry("来自 ChatGPT", "send", { site: "chatgpt.com", title: "ChatGPT", fieldKey: "gpt" }),
    secondStore.addEntry("来自 Gemini", "send", { site: "gemini.google.com", title: "Gemini", fieldKey: "gemini" })
  ]);

  const sites = await firstStore.getSites();
  assert.deepEqual(Array.from(sites), ["chatgpt.com", "gemini.google.com"]);
});
