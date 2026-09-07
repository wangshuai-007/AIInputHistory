const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "../src/history-store.js"), "utf8");

function setup(entries = [], drafts = {}) {
  const data = { aiInputHistoryState: { entries, drafts } };
  const sandbox = { URL, chrome: { runtime: {}, storage: { local: {
    get(key, callback) { callback({ [key]: structuredClone(data[key]) }); },
    set(value, callback) { Object.assign(data, structuredClone(value)); callback(); }
  } } } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return { store: new sandbox.AIInputHistory.HistoryStore(), model: sandbox.AIInputHistory.historyModel };
}

test("固定消息不占缓存限额且不被发送合并隐藏", () => {
  const { model } = setup();
  const pinned = { id: "p", text: "保留", kind: "snapshot", pinned: true, createdAt: 1, fieldKey: "f", sessionId: "s" };
  const entries = [pinned, ...Array.from({ length: 25 }, (_, i) => ({ id: String(i), kind: "snapshot", createdAt: i + 2 }))];
  assert.equal(model.pruneEntries(entries, { historyLimit: 20 }).length, 21);
  assert.ok(model.collapseSnapshotsForSend([pinned], "f", "s").length);
  assert.equal(model.compactSentSnapshots([pinned, { kind: "send", sessionId: "s" }]).length, 2);
  assert.equal(model.pruneEntries([{ ...pinned, kind: "send" }, { kind: "send", createdAt: 99 }], { sendLimit: 1 }).length, 2);
});

test("固定筛选与网站和搜索组合", async () => {
  const { store } = setup([
    { id: "1", text: "React", site: "a", pinned: true, kind: "send", createdAt: 1 },
    { id: "2", text: "React", site: "b", pinned: true, kind: "send", createdAt: 2 },
    { id: "3", text: "React", site: "a", kind: "send", createdAt: 3 }
  ]);
  assert.equal((await store.getHistory("react", false, "a", true)).length, 1);
});

test("固定消息跨清空和设置裁剪保留，解除后可清除", async () => {
  const entry = { id: "1", text: "保留", kind: "send", createdAt: 1 };
  const { store } = setup([entry], { f: { text: "草稿" } });
  await store.setPinned(entry, true);
  await store.saveSettings({ sendLimit: 1 });
  await store.addEntry("新发送", "send", { fieldKey: "other" });
  await store.clearHistory();
  assert.equal((await store.getState()).entries.length, 1);
  assert.equal(Object.keys((await store.getState()).drafts).length, 0);
  await store.setPinned(entry, false);
  await store.clearHistory();
  assert.equal((await store.getState()).entries.length, 0);
});

test("固定草稿保存当时文本，后续输入和清空不影响它", async () => {
  const { store } = setup([], { f: { text: "原文", updatedAt: 1, site: "a" } });
  const draft = (await store.getHistory("", false))[0];
  await store.setPinned(draft, true);
  await store.saveDraft("f", "新内容", { site: "a" });
  await store.clearHistory();
  const entries = await store.getHistory("", false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, "原文");
  assert.equal(entries[0].pinned, true);
});

test("已删除记录固定失败不会静默成功", async () => {
  const { store } = setup();
  await assert.rejects(store.setPinned({ id: "missing", kind: "send" }, true));
});
