const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "history-store.js"), "utf8");
const context = { globalThis: {}, URL };
vm.runInNewContext(source, context);
const { filterEntries, latestSnapshotTime, normalizeDomain, pruneEntries, sanitizeSettings } = context.globalThis.AIInputHistory.historyModel;

test("发送记录按独立上限裁剪，全部记录保持倒序", () => {
  const entries = [
    { id: "a", text: "旧发送", kind: "send", createdAt: 1 },
    { id: "b", text: "普通快照", kind: "snapshot", createdAt: 2 },
    { id: "c", text: "新发送", kind: "send", createdAt: 3 }
  ];
  const result = pruneEntries(entries, { historyLimit: 20, sendLimit: 1, snapshotMinutes: 1 });
  assert.deepEqual(Array.from(result, (entry) => entry.id), ["c", "b"]);
});

test("搜索不区分大小写并可只看发送记录", () => {
  const entries = [
    { text: "Explain React", kind: "snapshot", createdAt: 3 },
    { text: "react hooks", kind: "send", createdAt: 2 },
    { text: "Vue", kind: "send", createdAt: 1 }
  ];
  assert.deepEqual(Array.from(filterEntries(entries, "REACT", true), (entry) => entry.text), ["react hooks"]);
});

test("历史记录可按网站过滤", () => {
  const entries = [
    { text: "当前网站", kind: "snapshot", site: "chat.example", createdAt: 2 },
    { text: "其他网站", kind: "snapshot", site: "other.example", createdAt: 1 }
  ];
  const currentSite = filterEntries(entries, "", false, "chat.example");
  assert.deepEqual(Array.from(currentSite, (entry) => entry.text), ["当前网站"]);
  assert.equal(filterEntries(entries, "", false, "*").length, 2);
});

test("可读取当前网站最近一次自动保存时间", () => {
  const entries = [
    { kind: "snapshot", site: "chatgpt.com", createdAt: 10 },
    { kind: "send", site: "chatgpt.com", createdAt: 30 },
    { kind: "snapshot", site: "gemini.google.com", createdAt: 40 },
    { kind: "snapshot", site: "chatgpt.com", createdAt: 20 }
  ];
  assert.equal(latestSnapshotTime(entries, "chatgpt.com"), 20);
  assert.equal(latestSnapshotTime(entries, "gemini.google.com"), 40);
});

test("设置值被限制在安全范围", () => {
  const settings = sanitizeSettings({ historyLimit: 9999, enterLimit: 0, snapshotMinutes: "5" });
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), { historyLimit: 500, sendLimit: 1, snapshotSeconds: 300, shortcut: "Ctrl+R", launcherEnabled: true, customDomains: [] });
  assert.equal(sanitizeSettings({ snapshotSeconds: 5 }).snapshotSeconds, 5);
});

test("自定义域名会被规范化并去重", () => {
  assert.equal(normalizeDomain("https://WWW.Example.com/chat"), "example.com");
  const settings = sanitizeSettings({ customDomains: ["Example.com", "https://www.example.com/path", "invalid"] });
  assert.deepEqual(Array.from(settings.customDomains), ["example.com"]);
  assert.equal(sanitizeSettings({ launcherEnabled: false }).launcherEnabled, false);
});

test("未发送草稿会出现在可搜索历史中", async () => {
  const data = {
    aiInputHistoryState: {
      entries: [],
      drafts: {
        composer: { text: "尚未发送的草稿", updatedAt: 10, site: "example.ai", title: "Example" }
      }
    }
  };
  const sandbox = {
    chrome: {
      runtime: { lastError: null },
      storage: {
        local: {
          get: (key, callback) => callback({ [key]: data[key] }),
          set: (value, callback) => { Object.assign(data, value); callback(); }
        }
      }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const store = new sandbox.AIInputHistory.HistoryStore();
  const result = await store.getHistory("草稿", false);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, "draft");
  assert.equal(result[0].text, "尚未发送的草稿");
});

test("页面一键清除历史时保留用户拖动位置", async () => {
  const data = {
    aiInputHistoryState: {
      entries: [{ id: "send", text: "已发送", kind: "send", createdAt: 1 }],
      drafts: { composer: { text: "草稿", updatedAt: 2 } },
      positions: { "example.ai": { launcher: { x: 20, y: 30 }, updatedAt: 3 } }
    }
  };
  const sandbox = {
    chrome: {
      runtime: { lastError: null },
      storage: { local: {
        get: (key, callback) => callback({ [key]: data[key] }),
        set: (value, callback) => { Object.assign(data, value); callback(); }
      } }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const store = new sandbox.AIInputHistory.HistoryStore();
  await store.clearHistory();
  const state = await store.getState();
  assert.equal(state.entries.length, 0);
  assert.equal(Object.keys(state.drafts).length, 0);
  assert.equal(state.positions["example.ai"].launcher.x, 20);
});
