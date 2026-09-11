const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "content.js"), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function setup() {
  const h = {
    handlers: new Map(), windowHandlers: new Map(), timers: new Map(), intervals: new Map(), operations: [], warnings: [],
    composer: { id: "first", text: "旧草稿", isConnected: true, focus() {} },
    settings: { launcherEnabled: true, snapshotSeconds: 60, language: "zh-CN", customDomains: [] },
    nextId: 1, intervalStarts: 0
  };
  class Store {
    async getSettings() { return h.settings; }
    async getSiteIcons() { return {}; }
    async saveDraft(fieldKey, text, context) { h.operations.push({ kind: "draft", fieldKey, text, context }); }
    async addEntry(text, kind, context) {
      h.operations.push({ kind, text, context });
      if (h.blockAdd) await h.blockAdd;
      return { createdAt: 100 };
    }
  }
  class Panel {
    constructor() {
      h.panel = this;
      this.host = {};
      this.shadow = {};
      this.search = {};
      this.selected = 0;
      this.moves = 0;
    }
    setLauncherEnabled(enabled) { this.enabled = enabled; }
    setTarget(target) { this.target = target; }
    setLanguage() {}
    showSavedFeedback() {}
    isOpen() { return Boolean(this.opened); }
    isClearConfirmationOpen() { return Boolean(this.confirming); }
    isSiteFilterEvent() { return Boolean(this.siteFilterFocused); }
    closeClearConfirmation() { this.confirming = false; }
    choose() { this.selected += 1; }
    close() { this.opened = false; }
    moveSelection() { this.moves += 1; }
    async refresh() {}
  }
  const context = {
    globalThis: {}, console: { warn: (...args) => h.warnings.push(args) },
    location: { hostname: "chatgpt.com" },
    document: { title: "测试", addEventListener: (name, callback) => h.handlers.set(name, callback) },
    window: { addEventListener(name, callback) { h.windowHandlers.set(name, callback); } },
    setTimeout(callback, delay) { const id = h.nextId++; h.timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => h.timers.delete(id),
    setInterval(callback, delay) { const id = h.nextId++; h.intervalStarts += 1; h.intervals.set(id, { callback, delay }); return id; },
    clearInterval: (id) => h.intervals.delete(id),
    chrome: { storage: { onChanged: { addListener(callback) { h.change = callback; } } } }
  };
  context.globalThis.AIInputHistory = {
    HistoryStore: Store, HistoryPanel: Panel,
    RequestTiming: class { setEnabled() {} async restore() { return null; } capture() { return null; } start() { return null; } attach() {} finish() {} },
    i18n: { setLanguage() {} },
    SiteProfiles: { isAllowedSite: () => true, setSiteIcons() {} },
    captureSiteIcon: async () => null,
    STORAGE_KEYS: { settings: "settings", state: "state" },
    historyModel: { sanitizeSettings: (settings) => settings, matchesShortcut: () => false },
    InputAdapter: {
      findComposer: () => h.composer, fieldKey: (input) => input.id, getText: (input) => input.text,
      resolveEventEditable: (event) => event.editable, isEditable: (input) => Boolean(input), composerScore: () => 10,
      canMoveVertically: () => Boolean(h.caretCanMove)
    },
    HistoryNavigator: class {
      constructor() { h.historyNavigator = this; this.reset(); this.moves = 0; this.interrupts = 0; }
      reset() { this.browsing = false; this.blocked = false; }
      isApplying() { return false; }
      isBrowsing() { return this.browsing; }
      canMove() { return !this.blocked; }
      interrupt() {
        if (!this.browsing && !this.blocked) return false;
        this.blocked = true;
        this.interrupts += 1;
        return true;
      }
      async move() { if (this.blocked) return false; this.browsing = true; this.moves += 1; return true; }
    },
    SendDetector: class {
      constructor(adapter, onSend) { this.onSend = onSend; }
      handleSubmit(event, input, context) { this.onSend(input.text, context); }
      handlePointerDown() {}
      watchEnter() {}
      cancelEnter() {}
    }
  };
  await vm.runInNewContext(source, context);
  h.event = (name, overrides = {}) => {
    const event = {
      editable: h.composer, target: h.composer, composedPath: () => [h.composer],
      preventDefault() { this.defaultPrevented = true; },
      stopImmediatePropagation() { this.propagationStopped = true; },
      ...overrides
    };
    if (name === "keydown") h.windowHandlers.get(name)?.(event);
    if (!event.propagationStopped) h.handlers.get(name)(event);
    return event;
  };
  h.snapshot = () => [...h.intervals.values()][0].callback();
  h.drafts = () => [...h.timers.values()].filter((timer) => timer.delay === 500).forEach((timer) => timer.callback());
  return h;
}

test("启动时自动找到输入框，重新启用按钮时重新找到替换后的输入框", async () => {
  const h = await setup();
  assert.equal(h.panel.target, h.composer);
  const disabled = { ...h.settings, launcherEnabled: false };
  h.change({ settings: { oldValue: h.settings, newValue: disabled } }, "local");
  h.composer.isConnected = false;
  h.composer = { id: "replacement", text: "", isConnected: true };
  h.change({ settings: { oldValue: disabled, newValue: h.settings } }, "local");
  assert.equal(h.panel.enabled, true);
  assert.equal(h.panel.target, h.composer);
});

test("反复聚焦同一输入框不推迟快照，修改秒数只保留一个计时器", async () => {
  const h = await setup();
  h.event("focusin");
  h.event("focusin");
  assert.equal(h.intervalStarts, 1);
  h.change({ settings: { oldValue: h.settings, newValue: { ...h.settings, snapshotSeconds: 5 } } }, "local");
  assert.equal(h.intervals.size, 1);
  assert.equal([...h.intervals.values()][0].delay, 5000);
});

test("快照进行中不会重复保存，切换输入框后仍使用原上下文", async () => {
  const h = await setup();
  let release;
  h.blockAdd = new Promise((resolve) => { release = resolve; });
  h.snapshot();
  h.snapshot();
  await flush();
  h.composer = { id: "second", text: "新草稿", isConnected: true };
  h.event("focusin");
  release();
  await flush();
  assert.equal(h.operations.filter((item) => item.kind === "snapshot").length, 1);
  assert.ok(h.operations.filter((item) => item.text === "旧草稿").every((item) => item.context.fieldKey === "first"));
});

test("旧快照、发送与下一条草稿串行保存，不会把已发送内容写回草稿", async () => {
  const h = await setup();
  let release;
  h.blockAdd = new Promise((resolve) => { release = resolve; });
  h.snapshot();
  await flush();
  h.event("submit");
  h.composer.text = "下一条问题";
  h.event("input");
  h.drafts();
  release();
  await flush();
  assert.deepEqual(h.operations.map((item) => item.kind), ["snapshot", "draft", "send", "draft", "draft"]);
  assert.equal(h.operations[3].text, "");
  assert.equal(h.operations[4].text, "下一条问题");
  assert.notEqual(h.operations[2].context.sessionId, h.operations[4].context.sessionId);
});

test("上下键只在光标到达首尾行边界时切换历史", async () => {
  const h = await setup();
  h.caretCanMove = true;
  const within = h.event("keydown", { key: "ArrowUp" });
  assert.equal(within.defaultPrevented, undefined, "还能上一行时应保留编辑框原生移动");
  assert.equal(within.propagationStopped, true, "仍需隔离页面自己的 ArrowUp 快捷键");
  assert.equal(h.historyNavigator.moves, 0);

  h.caretCanMove = false;
  const boundary = h.event("keydown", { key: "ArrowUp" });
  assert.equal(boundary.defaultPrevented, true, "已在第一行时才接管 ArrowUp");
  assert.equal(h.historyNavigator.moves, 1);

  h.historyNavigator.reset();
  h.historyNavigator.moves = 0;
  h.caretCanMove = true;
  const withinDown = h.event("keydown", { key: "ArrowDown" });
  assert.equal(withinDown.defaultPrevented, undefined, "还能下一行时应保留编辑框原生移动");
  assert.equal(h.historyNavigator.moves, 0);
  h.caretCanMove = false;
  const boundaryDown = h.event("keydown", { key: "ArrowDown" });
  assert.equal(boundaryDown.defaultPrevented, true, "已在最后一行时才接管 ArrowDown");
  assert.equal(h.historyNavigator.moves, 1);
});

test("历史轮换后手动编辑文本会把上下键交还给输入框", async () => {
  const h = await setup();
  const first = h.event("keydown", { key: "ArrowUp" });
  assert.equal(first.defaultPrevented, true);
  assert.equal(first.propagationStopped, true, "历史切换时不能让同一个方向键继续交给页面处理");
  assert.equal(h.historyNavigator.moves, 1);

  h.composer.text = "编辑过的历史内容";
  h.event("input");
  assert.equal(h.historyNavigator.canMove(), false);
  const next = h.event("keydown", { key: "ArrowUp" });
  assert.equal(next.defaultPrevented, undefined, "中断后要保留浏览器原生光标上下移动");
  assert.equal(next.propagationStopped, true, "中断后仍不能让方向键泄漏给 ChatGPT 快捷键处理");
  assert.equal(h.historyNavigator.moves, 1);
});

test("历史轮换后键盘或鼠标移动光标会恢复原生上下行移动", async () => {
  for (const moveCaret of [
    (h) => h.event("keydown", { key: "ArrowLeft" }),
    (h) => h.event("pointerdown", { composedPath: () => [h.composer] })
  ]) {
    const h = await setup();
    h.event("keydown", { key: "ArrowUp" });
    moveCaret(h);
    assert.equal(h.historyNavigator.canMove(), false);
    const next = h.event("keydown", { key: "ArrowDown" });
    assert.equal(next.defaultPrevented, undefined);
    assert.equal(next.propagationStopped, true);
    assert.equal(h.historyNavigator.moves, 1);
  }
});

test("闭合 Shadow DOM 中关闭、清空、固定和过滤按钮保留原生 Enter", async () => {
  const h = await setup();
  h.panel.opened = true;
  for (const name of ["close", "clear", "pin-button", "filter", "confirm-accept"]) {
    h.panel.shadow.activeElement = { classList: { contains: (value) => value === name } };
    const event = h.event("keydown", { key: "Enter", editable: null, composedPath: () => [h.panel.host] });
    assert.equal(event.defaultPrevented, undefined, name);
  }
  assert.equal(h.panel.selected, 0);
});

test("网站下拉 Escape 不关闭整个面板，确认对话框 Enter 不插入历史", async () => {
  const h = await setup();
  h.panel.opened = true;
  h.panel.siteFilterFocused = true;
  h.event("keydown", { key: "Escape" });
  assert.equal(h.panel.opened, true);
  h.panel.siteFilterFocused = false;
  h.panel.confirming = true;
  const event = h.event("keydown", { key: "Enter" });
  assert.equal(event.defaultPrevented, undefined);
  assert.equal(h.panel.selected, 0);
});

test("搜索框仍支持上下选择及 Enter 插入", async () => {
  const h = await setup();
  h.panel.opened = true;
  h.panel.shadow.activeElement = h.panel.search;
  const event = h.event("keydown", { key: "ArrowDown", editable: null, composedPath: () => [h.panel.host] });
  h.event("keydown", { key: "Enter", editable: null, composedPath: () => [h.panel.host] });
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.panel.moves, 1);
  assert.equal(h.panel.selected, 1);
});

test("浏览器验收页加载请求计时依赖，且方向键守卫从 document_start 注册", () => {
  for (const name of ["browser-fixture.html", "chatgpt-error-fixture.html"]) {
    const html = fs.readFileSync(path.join(__dirname, name), "utf8");
    const timing = html.indexOf("../src/request-timing.js");
    const timingView = html.indexOf("../src/request-timing-view.js");
    const panel = html.indexOf("../src/history-panel.js");
    const content = html.indexOf("../src/content.js");
    assert.ok(timing >= 0 && timingView > timing, name);
    assert.ok(panel > timingView && content > panel, name);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.equal(manifest.content_scripts[0].run_at, "document_start");
});
