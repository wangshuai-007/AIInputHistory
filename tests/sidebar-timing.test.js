const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "../src/sidebar-timing.js"), "utf8");
function setup() {
  const ns = {
    requestTimingModel: { conversationIdFromPath: (pathname) =>
      String(pathname || "").match(/\/c\/([^/?#]+)/)?.[1] || null }
  };
  const context = { globalThis: { AIInputHistory: ns }, URL, console };
  vm.runInNewContext(source, context);
  let now = 61_000;
  const events = [];
  const diagnostics = [];
  const links = [];
  const doc = {
    querySelectorAll(selector) {
      if (selector === 'a[href*="/c/"]') return links;
      if (selector === "[data-aih-sidebar-timer]") return links.flatMap((link) => link.badges);
      return [];
    },
    createElement() {
      const attrs = {};
      const badge = {
        style: {}, textContent: "", title: "", listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
        setAttribute(name, value) { attrs[name] = value; },
        remove() { this.owner.badges = this.owner.badges.filter((item) => item !== this); }
      };
      return badge;
    }
  };
  function link(id, status = "unknown", project = false) {
    const ref = {
      id, status, project, badges: [],
      getAttribute(name) { return name === "href" ? "/c/" + id : null; },
      matches(selector) { return selector.includes('[data-aih-test-status="' + this.status + '"]'); },
      querySelector(selector) {
        if (selector === "[data-aih-sidebar-timer]") return this.badges[0] || null;
        return null;
      },
      closest() { return null; },
      appendChild(badge) { badge.owner = this; this.badges.push(badge); }
    };
    links.push(ref);
    return ref;
  }
  const timer = new ns.SidebarTiming({
    site: "chatgpt.com", origin: "https://chatgpt.com",
    getPath: () => "/c/current", now: () => now, documentRef: doc,
    timer: () => 1, untimer: () => {},
    onStatus: async (entry) => { events.push(entry); return { ok: true }; },
    onDiagnostic: (event) => { diagnostics.push(event); }
  });
  timer.setEnabled(true);
  const state = (id, overrides = {}) => ({
    site: "chatgpt.com", path: "/c/" + id, conversationId: id,
    requestId: "req-" + id, startedAt: 1000, pausedAt: null,
    pausedDurationMs: 0, sidebarUnreadCleared: true, ...overrides
  });
  const snapshot = (...states) => Object.fromEntries(states.map((item) => [item.requestId, item]));
  return { timer, events, diagnostics, link, state, snapshot, setNow(value) { now = value; } };
}

test("项目列表和最近会话重复出现时分别显示同一数字，切换会话不会把时间混到一起", () => {
  const h = setup();
  const aRecent = h.link("alpha");
  const aProject = h.link("alpha", "unknown", true);
  const b = h.link("beta");
  h.timer.update(h.snapshot(h.state("alpha"), h.state("beta", { startedAt: 30_000 })));
  assert.equal(aRecent.badges[0].textContent, "1:00");
  assert.equal(aProject.badges[0].textContent, "1:00");
  assert.equal(b.badges[0].textContent, "31s");
  h.setNow(62_000);
  h.timer.render();
  assert.equal(aRecent.badges[0].textContent, "1:01");
  assert.equal(b.badges[0].textContent, "32s");
  h.timer.update(h.snapshot(h.state("beta")));
  assert.equal(aRecent.badges.length, 0, "结束会话 A 后项目标签数字必须消失");
  assert.equal(aProject.badges.length, 0);
  assert.equal(b.badges.length, 1);
});

test("明确暂停状态冻结数字，后台同步后恢复只计入实际运行秒数", async () => {
  const h = setup();
  const row = h.link("alpha", "paused");
  h.timer.update(h.snapshot(h.state("alpha")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events[0].status, "paused");
  h.setNow(73_000);
  h.timer.update(h.snapshot(h.state("alpha", { pausedAt: 61_000, pauseVersion: 61000 })));
  assert.equal(row.badges[0].textContent, "⏸ 1:00");
  h.setNow(83_000);
  h.timer.render();
  assert.equal(row.badges[0].textContent, "⏸ 1:00", "暂停时不应继续增长");
  row.status = "running";
  h.timer.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(h.events.some((event) => event.status === "running"));
  h.timer.update(h.snapshot(h.state("alpha", { pausedDurationMs: 22_000, pauseVersion: 83000 })));
  h.timer.render();
  assert.equal(row.badges[0].textContent, "1:00");
});

test("侧边栏未读完成提示须稳定并仅影响对应会话，旧未读圆点不算新完成", async () => {
  const h = setup();
  const a = h.link("alpha", "completed");
  h.link("beta", "unknown");
  h.timer.update(h.snapshot(h.state("alpha", { sidebarUnreadCleared: false }), h.state("beta")));
  h.setNow(64_000);
  h.timer.scan();
  assert.equal(h.events.length, 0, "发送前已存在未读状态不能结束新请求");
  a.status = "running";
  h.timer.scan();
  h.timer.update(h.snapshot(h.state("alpha", { sidebarUnreadCleared: true }), h.state("beta")));
  a.status = "completed";
  h.timer.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.some((event) => event.status === "completed"), false, "状态须稳定至少 1 秒");
  h.setNow(65_300); h.timer.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.filter((event) => event.status === "completed").length, 1);
  assert.equal(h.events.find((event) => event.status === "completed").requestId, "req-alpha");
  h.timer.update(h.snapshot(h.state("beta")));
  assert.equal(a.badges.length, 0);
});

test("暂停图标位于链接外层列表项时也能匹配，但不会误读旁边的其他会话", async () => {
  const h = setup();
  const a = h.link("outer-paused");
  const b = h.link("unrelated");
  const indicator = {
    label: "Waiting for your input",
    getAttribute(name) { return name === "aria-label" ? this.label : name === "role" ? "status" : null; },
    matches() { return false; }
  };
  const parent = {
    parentElement: null, querySelector() { return null; }, matches() { return false; },
    querySelectorAll(selector) {
      return selector === 'a[href*="/c/"]' ? [a]
        : selector.includes('[role="status"]') ? [indicator] : [];
    }
  };
  a.parentElement = parent;
  assert.equal(h.timer.getStatusForPath("/c/outer-paused"), "paused", "列表项兄弟状态提示应生效");
  assert.equal(h.timer.getStatusForPath("/c/unrelated"), "unknown");
  h.timer.update(h.snapshot(h.state("outer-paused"), h.state("unrelated")));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.filter((event) => event.status === "paused").length, 1);
  indicator.label = "Generating";
  assert.equal(h.timer.getStatusForPath("/c/outer-paused"), "running");
  // A wrapper with two separate conversations must not leak one item's status into the other.
  parent.querySelectorAll = (selector) => selector === 'a[href*="/c/"]'
    ? [a,b] : selector.includes('[role="status"]') ? [indicator] : [];
  assert.equal(h.timer.getStatusForPath("/c/outer-paused"), "unknown");
});

test("未识别的后台状态每分钟留下脱敏诊断，但不会擅自暂停", () => {
  const h = setup();
  h.link("unknown-state", "unknown");
  h.timer.update(h.snapshot(h.state("unknown-state")));
  assert.equal(h.diagnostics.length, 1);
  assert.equal(h.diagnostics[0].stage, "timing-sidebar-status-unknown");
  assert.equal(h.diagnostics[0].conversationId, "unknown-state");
  assert.equal(h.events.some((event) => event.status === "paused"), false);
  h.setNow(95_000); h.timer.scan();
  assert.equal(h.diagnostics.length, 1, "频繁扫描时不可刷屏");
  h.setNow(121_100); h.timer.scan();
  assert.equal(h.diagnostics.length, 2);
  assert.doesNotMatch(JSON.stringify(h.diagnostics), /promptText|responseText|conversationTitle/);
});

test("右键其他会话计时数字能够暂停和恢复；手动暂停不被侧边栏自动运行标记覆盖", async () => {
  const h = setup();
  const a = h.link("manual-clock", "running");
  h.timer.update(h.snapshot(h.state("manual-clock")));
  const badge = a.badges[0];
  assert.equal(typeof badge.listeners.contextmenu, "function");
  let prevented = false;
  badge.listeners.contextmenu({ preventDefault() { prevented = true; }, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(h.events.at(-1).status, "manual-paused");
  h.timer.update(h.snapshot(h.state("manual-clock", { manualPause: true, pausedAt: 60_000, pauseVersion: 61000 })));
  assert.match(a.badges[0].textContent, /^⏸/);
  h.timer.scan();
  assert.equal(h.events.some((event) => event.status === "running"), false, "不能取消用户手动暂停");
  badge.listeners.contextmenu({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.events.at(-1).status, "manual-running");
  h.timer.update(h.snapshot(h.state("manual-clock", { manualPause: false, pausedAt: null,
    pausedDurationMs: 3200, pauseVersion: 65000 })));
  assert.doesNotMatch(a.badges[0].textContent, /^⏸/);
});

test("状态匹配只基于专门的图标或属性，聊天标题里有 Completed 也不能触发", () => {
  const h = setup();
  const row = h.link("question-that-says-completed", "unknown");
  assert.equal(h.timer.getStatusForPath("/c/question-that-says-completed"), "unknown");
  row.status = "paused";
  assert.equal(h.timer.getStatusForPath("/c/question-that-says-completed"), "paused");
  assert.equal(h.timer.getStatusForPath("/c/other"), "unknown");
  const model = h.timer.constructor;
  assert.equal(typeof model, "function");
});

test("后台拒绝过早的侧边栏完成时按 8 秒退避后重试，最终仍可正常结束", async () => {
  const h = setup();
  const row = h.link("busy-retry", "completed");
  const state = h.state("busy-retry");
  let calls = 0;
  h.timer.onStatus = async () => {
    calls += 1;
    return calls === 1 ? { ok: true, applied: false, reason: "generation-still-observed" }
      : { ok: true, applied: true, claimed: true };
  };
  h.timer.update(h.snapshot(state));
  h.setNow(62_100); h.timer.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  h.setNow(67_000); h.timer.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1, "等待心跳失效期间不能每秒重复请求后台");
  h.setNow(70_200); h.timer.scan();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, "拒绝完成不能永久禁止同一请求后续完成");
  h.timer.update(h.snapshot());
  assert.equal(row.badges.length, 0);
});
