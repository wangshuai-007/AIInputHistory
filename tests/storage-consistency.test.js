const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const storeSource = fs.readFileSync(path.join(__dirname, "../src/history-store.js"), "utf8");
const backgroundSource = fs.readFileSync(path.join(__dirname, "../background.js"), "utf8");

function setup(initial = {}) {
  const data = structuredClone(initial);
  let listener;
  let sequence = 0;
  const runtime = {
    lastError: null,
    onMessage: { addListener(value) { listener = value; } },
    sendMessage(message, callback) { listener(message, { tab: { id: 1 } }, callback); }
  };
  const sandbox = {
    URL, setTimeout, clearTimeout,
    crypto: { randomUUID: () => String(++sequence) },
    chrome: { runtime, storage: { local: {
      get(key, callback) { setTimeout(() => callback({ [key]: structuredClone(data[key]) }), 1); },
      set(value, callback) { setTimeout(() => { Object.assign(data, structuredClone(value)); callback(); }, 1); }
    } } }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(backgroundSource, sandbox);
  vm.runInNewContext(storeSource, sandbox);
  return { data, store: new sandbox.AIInputHistory.HistoryStore() };
}

test("不同窗口并发修改独立设置时互不覆盖", async () => {
  const { store } = setup();
  await Promise.all([
    store.patchSettings({ snapshotSeconds: 5 }),
    store.patchSettings({ launcherEnabled: false }),
    store.patchSettings({ language: "en" })
  ]);
  const settings = await store.getSettings();
  assert.equal(settings.snapshotSeconds, 5);
  assert.equal(settings.launcherEnabled, false);
  assert.equal(settings.language, "en");
});

test("同一网页多窗口草稿分别保存，发送清空不影响其他窗口", async () => {
  const { store } = setup();
  const first = { site: "chatgpt.com", fieldKey: "composer", sessionId: "first" };
  const second = { ...first, sessionId: "second" };
  await Promise.all([
    store.saveDraft("composer", "窗口一", first),
    store.saveDraft("composer", "窗口二", second)
  ]);
  const drafts = await store.getHistory("", false);
  assert.equal(drafts.length, 2);
  assert.notEqual(drafts[0].id, drafts[1].id);
  assert.ok(drafts.every((entry) => entry.fieldKey === "composer"));
  await store.saveDraft("composer", "", first);
  assert.deepEqual(Array.from(await store.getHistory("", false), (entry) => entry.text), ["窗口二"]);
});

test("相同文字的跨窗口快照不会被去重或被另一窗口发送删除", async () => {
  const { store } = setup();
  const first = { site: "chatgpt.com", fieldKey: "composer", sessionId: "first" };
  const second = { ...first, sessionId: "second" };
  const left = await store.addEntry("相同草稿", "snapshot", first);
  const right = await store.addEntry("相同草稿", "snapshot", second);
  assert.notEqual(left.id, right.id);
  await store.addEntry("相同草稿", "send", first);
  assert.ok((await store.getState()).entries.some((entry) => entry.id === right.id));
});

test("多个窗口重复固定同一草稿只保留一个固定副本", async () => {
  const { store } = setup();
  await store.saveDraft("composer", "需要固定", { site: "chatgpt.com", sessionId: "a" });
  const draft = (await store.getHistory("", false))[0];
  const [first, second] = await Promise.all([store.setPinned(draft, true), store.setPinned(draft, true)]);
  assert.equal(first.id, second.id);
  await store.clearHistory();
  assert.equal((await store.getState()).entries.length, 1);
});

test("旧格式草稿在写入新窗口草稿后仍保持可检索", async () => {
  const { store } = setup({ aiInputHistoryState: {
    entries: [], drafts: { composer: { text: "旧草稿", updatedAt: 1, site: "chatgpt.com" } }
  } });
  await store.saveDraft("composer", "新草稿", { site: "chatgpt.com", sessionId: "new" });
  const history = await store.getHistory("", false);
  assert.equal(history.length, 2);
  assert.equal(history.find((entry) => entry.text === "旧草稿").fieldKey, "composer");
});

test("损坏的单条记录不会使其他已固定历史不可读", async () => {
  const { store } = setup({ aiInputHistoryState: {
    entries: [null, { id: "broken" }, { id: "pinned", text: "受保护", pinned: true, kind: "send" }],
    drafts: { invalid: null, missingText: {} }
  } });
  assert.deepEqual(Array.from(await store.getHistory("受保护", false), (entry) => entry.id), ["pinned"]);
  await store.saveDraft("composer", "可继续保存", { site: "chatgpt.com", sessionId: "new" });
  assert.equal((await store.getSites()).length, 1);
});
