const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const files = ["site-profiles.js", "conversation-stats.js", "history-store.js"];
const sources = Object.fromEntries(files.map((file) => [file, fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8")]));

function modelContext() {
  const context = { URL, URLSearchParams, Date, globalThis: null };
  context.globalThis = context;
  context.AIInputHistory = { i18n: { t: (_key, _vars, fallback) => fallback || _key } };
  vm.runInNewContext(sources["site-profiles.js"], context);
  vm.runInNewContext(sources["conversation-stats.js"], context);
  return context;
}

function storeContext(initial = {}) {
  const context = modelContext();
  const data = { ...initial };
  context.chrome = {
    runtime: { lastError: null },
    storage: { local: {
      get(key, callback) { callback({ [key]: data[key] }); },
      set(value, callback) { Object.assign(data, value); callback?.(); }
    } }
  };  vm.runInNewContext(sources["history-store.js"], context);
  return { context, data, store: new context.AIInputHistory.HistoryStore() };
}

test("发送统计按 AI 归类", () => {
  const context = modelContext();
  const model = context.AIInputHistory.conversationStatsModel;
  assert.equal(model.aiKeyForSite("chatgpt.com"), "chatgpt");
  assert.equal(model.aiKeyForSite("chat.openai.com"), "chatgpt");
  assert.equal(model.aiKeyForSite("kimi.com"), "kimi");
});

test("同一会话每次实际发送都累计，并按日周月统计", async () => {
  const { store } = storeContext();
  const monday = new Date(2026, 8, 14, 9).getTime();
  const tuesday = new Date(2026, 8, 15, 9).getTime();
  const october = new Date(2026, 9, 1, 9).getTime();

  await store.recordSendStat({ aiKey: "chatgpt", site: "chatgpt.com", at: monday });
  await store.recordSendStat({ aiKey: "chatgpt", site: "chatgpt.com", at: monday });
  await store.recordSendStat({ aiKey: "chatgpt", site: "chatgpt.com", at: tuesday });
  await store.recordSendStat({ aiKey: "gemini", site: "gemini.google.com", at: tuesday });

  const september = await store.getSendStats(tuesday);
  assert.equal(september.all.total, 4);
  assert.equal(september.all.today, 2);  assert.equal(september.all.thisWeek, 4);
  assert.equal(september.all.thisMonth, 4);
  assert.deepEqual(Array.from(september.rows, (row) => [row.aiKey, row.total]), [["chatgpt", 3], ["gemini", 1]]);

  await store.recordSendStat({ aiKey: "chatgpt", site: "chatgpt.com", at: october });
  await store.recordSendStat({ aiKey: "chatgpt", site: "chatgpt.com", at: october });
  const nextMonth = await store.getSendStats(october);
  assert.equal(nextMonth.all.total, 6);
  assert.equal(nextMonth.all.thisMonth, 2);
});

test("旧版会话统计不会冒充发送次数", async () => {
  const legacy = {
    aiInputHistoryConversationStats: {
      version: 1,
      byAi: {
        chatgpt: { site: "chatgpt.com", total: 99, days: { "2026-09-14": 9 }, weeks: {}, months: {}, seen: {} }
      }
    }
  };
  const { store } = storeContext(legacy);
  const at = new Date(2026, 8, 14, 10).getTime();
  const before = await store.getSendStats(at);
  assert.equal(before.all.total, 0, "旧会话数不能直接作为发送次数");

  await store.recordSendStat({ aiKey: "chatgpt", site: "chatgpt.com", at });
  const after = await store.getSendStats(at);
  assert.equal(after.all.total, 1);  assert.equal(after.all.today, 1);
});

test("历史与发送统计可以互相独立清空", async () => {
  const initial = {
    aiInputHistoryState: { entries: [{ id: "x", text: "保留历史", kind: "send", createdAt: 1 }], drafts: {}, positions: {}, siteIcons: {} }
  };
  const { store, data } = storeContext(initial);
  const at = new Date(2026, 8, 14, 10).getTime();

  await store.recordSendStat({ aiKey: "chatgpt", site: "chatgpt.com", at });
  assert.equal((await store.getSendStats(at)).all.total, 1);
  await store.clearHistory();
  assert.equal((await store.getSendStats(at)).all.total, 1);
  assert.equal((await store.getState()).entries.length, 0);

  data.aiInputHistoryState.entries = [{ id: "y", text: "另一条历史", kind: "send", createdAt: 2 }];
  await store.clearSendStats();
  assert.equal((await store.getSendStats(at)).all.total, 0);
  assert.equal((await store.getState()).entries[0].text, "另一条历史");
});
