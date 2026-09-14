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

test("会话标识按 AI 归类，稳定会话 URL 可跨刷新去重", () => {
  const context = modelContext();
  const model = context.AIInputHistory.conversationStatsModel;
  assert.equal(model.aiKeyForSite("chatgpt.com"), "chatgpt");
  assert.equal(model.aiKeyForSite("chat.openai.com"), "chatgpt");
  assert.equal(model.aiKeyForSite("kimi.com"), "kimi");
  const stable = model.resolveConversation({ hostname: "chatgpt.com", pathname: "/c/abc123456789", search: "", hash: "" }, "page-a");
  assert.equal(stable.stable, true);
  assert.equal(stable.key, model.resolveConversation({ hostname: "chatgpt.com", pathname: "/c/abc123456789", search: "", hash: "" }, "page-b").key);
  const freshA = model.resolveConversation({ hostname: "chatgpt.com", pathname: "/", search: "", hash: "" }, "page-a");
  const freshB = model.resolveConversation({ hostname: "chatgpt.com", pathname: "/", search: "", hash: "" }, "page-b");
  assert.equal(freshA.stable, false);
  assert.notEqual(freshA.key, freshB.key);
});

function storeContext(initial = {}) {
  const context = modelContext();
  const data = { ...initial };
  context.chrome = {
    runtime: { lastError: null },
    storage: { local: {
      get(key, callback) { callback({ [key]: data[key] }); },
      set(value, callback) { Object.assign(data, value); callback?.(); }
    } }
  };
  vm.runInNewContext(sources["history-store.js"], context);
  return { context, data, store: new context.AIInputHistory.HistoryStore() };
}

test("同一会话只计一次，不同 AI 分开统计日周月", async () => {
  const { store } = storeContext();
  const monday = new Date(2026, 8, 14, 9).getTime();
  const tuesday = new Date(2026, 8, 15, 9).getTime();
  const october = new Date(2026, 9, 1, 9).getTime();
  assert.equal((await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: "chatgpt.com/c/1", at: monday })).added, true);
  assert.equal((await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: "chatgpt.com/c/1", at: tuesday })).added, false);
  await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: "chatgpt.com/c/2", at: monday });
  await store.recordConversationStat({ aiKey: "gemini", site: "gemini.google.com", conversationKey: "gemini.google.com/app/2", at: tuesday });

  const september = await store.getConversationStats(tuesday);
  assert.equal(september.all.total, 3);
  assert.equal(september.all.today, 2);
  assert.equal(september.all.thisWeek, 3);
  assert.equal(september.all.thisMonth, 3);
  assert.equal(september.all.activeDays, 2);
  assert.equal(september.all.activeWeeks, 1);
  assert.equal(september.all.activeMonths, 1);
  assert.deepEqual(Array.from(september.rows, (row) => [row.aiKey, row.total]), [["chatgpt", 2], ["gemini", 1]]);

  await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: "chatgpt.com/c/3", at: october });
  await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: "chatgpt.com/c/1", at: october });
  const nextMonth = await store.getConversationStats(october);
  assert.equal(nextMonth.all.total, 4);
  assert.equal(nextMonth.all.thisMonth, 2);
  assert.equal(nextMonth.all.activeMonths, 2);
});

test("新建页临时会话切换到稳定 URL 时只建立别名不重复计数", async () => {
  const { store } = storeContext();
  const at = new Date(2026, 8, 14, 10).getTime();
  const temporaryKey = "chatgpt.com:page-session:temp";
  await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: temporaryKey, at });
  assert.equal(await store.markConversationStatSeen("chatgpt", "chatgpt.com/c/stable123456", at, temporaryKey), true);
  const duplicate = await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: "chatgpt.com/c/stable123456", at });
  assert.equal(duplicate.added, false);
  assert.equal((await store.getConversationStats(at)).all.total, 1);
});

test("历史与对话统计可以互相独立清空", async () => {
  const initial = {
    aiInputHistoryState: { entries: [{ id: "x", text: "保留历史", kind: "send", createdAt: 1 }], drafts: {}, positions: {}, siteIcons: {} }
  };
  const { store, data } = storeContext(initial);
  const at = new Date(2026, 8, 14, 10).getTime();
  await store.recordConversationStat({ aiKey: "chatgpt", site: "chatgpt.com", conversationKey: "chatgpt.com/c/1", at });
  assert.equal((await store.getConversationStats(at)).all.total, 1);
  await store.clearHistory();
  assert.equal((await store.getConversationStats(at)).all.total, 1);
  assert.equal((await store.getState()).entries.length, 0);

  data.aiInputHistoryState.entries = [{ id: "y", text: "另一条历史", kind: "send", createdAt: 2 }];
  await store.clearConversationStats();
  assert.equal((await store.getConversationStats(at)).all.total, 0);
  assert.equal((await store.getState()).entries[0].text, "另一条历史");
});
