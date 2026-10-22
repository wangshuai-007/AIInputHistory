const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

function models() {
  const ctx = { Date, URL, console };
  ctx.globalThis = ctx;
  ctx.AIInputHistory = {};
  for (const file of ["conversation-stats.js", "pro-usage.js", "pro-quota.js", "pro-badge.js"]) {
    vm.runInNewContext(read(file), ctx);
  }
  return ctx.AIInputHistory;
}

function usage(used = 4, now = Date.now()) {
  const date = new Date(now);
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")].join("-");
  const monday = new Date(date.getTime());
  monday.setDate(monday.getDate() - (monday.getDay() || 7) + 1);
  const week = [monday.getFullYear(), String(monday.getMonth() + 1).padStart(2, "0"),
    String(monday.getDate()).padStart(2, "0")].join("-");
  return { version: 1, models: {
    "gpt-6-pro": { total: used, days: { [day]: used }, weeks: { [week]: used }, months: { [day.slice(0, 7)]: used } }
  }};
}

function elements() {
  const picker = {
    isConnected: true, textContent: "GPT-6 Pro",
    getAttribute(name) { return name === "data-testid" ? "model-switcher-dropdown-button" : null; },
    closest() { return null; }, getClientRects() { return [{}]; },
    getBoundingClientRect() { return { left: 100, right: 162, top: 250, bottom: 280, width: 62, height: 30 }; }
  };
  const container = { inserted: [], appendChild(el) {
    el.parentNode = this;
    el.isConnected = true;
    this.inserted.push(el);
  }};
  picker.parentNode = container;
  const wrapper = { tagName: 'DIV', parentElement: container,
    querySelectorAll() { return doc.picker ? [doc.picker] : []; } };
  const editor = { parentElement: wrapper, closest() { return null; }, getClientRects() { return [{}]; } };
  const statuses = new Map();
  const documentElement = {
    getAttribute(name) { return statuses.get(name) ?? null; },
    setAttribute(name, value) { statuses.set(name, String(value)); },
    hasAttribute(name) { return statuses.has(name); }
  };
  const doc = {
    picker, body: container, documentElement,
    defaultView: { innerWidth: 1280, innerHeight: 800 },
    querySelectorAll(selector) {
      if (selector.includes('form[data-chatgpt-composer]')) return [editor];
      if (selector.includes('button[data-testid="send-button"]')) return [];
      return doc.picker ? [doc.picker] : [];
    },
    createElement() {
      return {
        isConnected: false, textContent: "", title: "", style: {}, attrs: {},
        setAttribute(name, value) { this.attrs[name] = value; },
        getAttribute(name) { return this.attrs[name] ?? null; },
        getBoundingClientRect() { return { width: 41, height: 22 }; },
        remove() {
          const arr = this.parentNode?.inserted;
          if (arr) arr.splice(arr.indexOf(this), 1);
          this.parentNode = null; this.isConnected = false;
        }
      };
    }
  };
  return { picker, doc, container };
}

test("模型旁的数字只在 Pro 开关打开且选中 Pro 模型时显示", () => {
  const ns = models();
  const { picker, doc, container } = elements();
  const badge = new ns.ProModelBadge({ documentRef: doc, host: "chatgpt.com",
    timer: () => 1, untimer: () => {}, Observer: null });
  badge.updateUsage(usage());
  badge.setSettings({ trackRequestTime: true, trackProUsage: false, proPlan: "pro-100" });
  assert.equal(container.inserted.length, 0, "只打开耗时开关时不得显示 Pro 余额");
  badge.setSettings({ trackRequestTime: false, trackProUsage: true, proPlan: "pro-100" });
  assert.equal(container.inserted.length, 1);
  assert.equal(badge.badge.textContent, "(46)");
  assert.equal(badge.badge.title, "", "不显示本地估算说明气泡");
  badge.updateUsage(usage(5));
  assert.equal(badge.badge.textContent, "(45)", "新请求被后台计入后，模型旁应实时递减");
  picker.textContent = "GPT-6 Instant";
  badge.render();
  assert.equal(container.inserted.length, 0, "切换为普通模型立即移除数字");
  picker.textContent = "GPT-6 Pro";
  badge.render();
  assert.equal(badge.badge.textContent, "(45)");
  badge.setSettings({ trackRequestTime: true, trackProUsage: false, proPlan: "pro-100" });
  assert.equal(container.inserted.length, 0, "关闭 Pro 计数必须隐藏数字，耗时开关无关");
});

test("套餐未知显示问号，不捏造 Pro 剩余次数", () => {
  const ns = models();
  const { doc } = elements();
  const badge = new ns.ProModelBadge({ documentRef: doc, host: "chatgpt.com" });
  badge.setSettings({ trackProUsage: true, proPlan: "unknown" });
  assert.equal(badge.badge.textContent, "(?)");
  assert.equal(badge.badge.title, "", "未知套餐也不弹出提示");
  badge.setSettings({ trackProUsage: true, proPlan: "enterprise" });
  assert.equal(badge.badge.textContent, "(?)");
});

test("只有网页直接显示的剩余次数才能标为页面来源，旧提示自动失效", () => {
  const ns = models();
  const now = new Date(2026, 9, 21, 12).getTime();
  const quotas = {
    "gpt-6-pro": {
      status: "remaining-shown", source: "chatgpt-visible-ui",
      remaining: 7, observedAt: now - 4000, resetAt: now + 3600000
    }
  };
  const m = ns.proBadgeModel;
  const fromUI = m.displayFor("gpt-6-pro", "pro-100", usage(6, now), quotas, now);
  assert.equal(fromUI.text, "剩余 7");
  assert.equal(fromUI.kind, "ui");
  const fromLocal = m.displayFor("gpt-6-pro", "pro-100", usage(6, now), quotas, now + 10 * 60 * 1000);
  assert.equal(fromLocal.kind, "estimated");
  assert.equal(fromLocal.text, "≈44");
});

test("可见的额度限制提示需要明确提到 Pro 模型，不能读取聊天正文或套餐广告", () => {
  const ns = models();
  const now = new Date(2026, 9, 21, 12).getTime();
  const q = ns.proQuotaModel;
  assert.equal(q.parseMessage("Upgrade to Pro $200 to increase limits", now), null);
  assert.equal(q.parseMessage("GPT-6 Pro is available on ChatGPT Pro plans", now), null);
  assert.equal(q.parseMessage("Thinking limit reached", now), null);
  const limit = q.parseMessage("You've reached the GPT-6 Pro limit. Resets 2026-10-22 09:30", now);
  assert.equal(limit.status, "limit-reached");
  assert.equal(limit.modelId, "gpt-6-pro");
  assert.ok(limit.resetAt > now);
  const remain = q.parseMessage("GPT-5.6 Sol Pro remaining: 12", now);
  assert.equal(remain.modelId, "gpt-5.6-pro");
  assert.equal(remain.remaining, 12);
  assert.equal(q.activeStatus({ ...remain, observedAt: now - 10 * 60 * 1000 }, now), null);
  assert.equal(q.activeStatus({ ...remain, observedAt: now - 2000 }, now).status, "remaining-shown");
});

test("Pro $200 页面只显示 Pro 时给出有数字但明确标明上限的结果", () => {
  const ns = models();
  const now = new Date(2026, 9, 22, 12).getTime();
  const result = ns.proBadgeModel.displayFor("pro", "pro-200", usage(4, now), null, now);
  assert.equal(result.text, "≤196");
  assert.equal(result.kind, "upper-bound");
  assert.match(result.detail, /上限可能更低|不是 ChatGPT 官方/);
  assert.equal(ns.proBadgeModel.displayFor("pro", "unknown", usage(4, now), null, now).text,
    "剩余 ?", "无法确认套餐时不能捏造官方剩余数字");
  assert.equal(ns.proBadgeModel.displayFor("pro", "pro-500", usage(4, now), null, now).text,
    "剩余 ?", "没有可信上限的套餐不能捏造额度");
});

test("剩余数字贴在 Pro 文字右下角，不修改按钮内部结构且不会超出窗口", () => {
  const ns = models();
  const { picker, doc, container } = elements();
  const badge = new ns.ProModelBadge({ documentRef: doc, host: "chatgpt.com", Observer: null });
  badge.updateUsage(usage(3));
  badge.setSettings({ trackProUsage: true, proPlan: "pro-100" });
  assert.equal(badge.badge.parentNode, doc.body);
  assert.match(badge.badge.style.cssText, /position:fixed/);
  assert.equal(badge.badge.style.left, "120px");
  assert.equal(badge.badge.style.top, "257px");
  assert.equal(picker.textContent, "GPT-6 Pro", "不得把 DOM 节点插入 React 管理的模型按钮");
  assert.equal(badge.badge.getAttribute("aria-hidden"), "true");
  assert.equal(badge.badge.getAttribute("aria-label"), null);
  assert.equal(badge.badge.title, "", "不得出现插件悬停提示");
  assert.match(badge.badge.style.cssText, /pointer-events:none/);
  picker.getBoundingClientRect = () => ({
    left: 1200, right: 1262, top: 250, bottom: 280, width: 62, height: 30
  });
  badge.render();
  assert.equal(badge.badge.style.left, "1220px", "括号数字必须在 Pro 原生按钮的矩形内");
  assert.equal(container.inserted.length, 1, "重新定位不应该创建多个徽标");

  const newPicker = { ...picker, textContent: "Pro" };
  doc.picker = newPicker;
  badge.render();
  assert.equal(badge.target, newPicker, "React 替换按钮后应重新绑定");
  assert.equal(container.inserted.length, 1);
  badge.setSettings({ trackProUsage: false, proPlan: "pro-100" });
  assert.equal(container.inserted.length, 0, "关闭 Pro 统计必须立即清理");
});


test("输入区没有 Pro 时不把数字回退到顶部模型入口", () => {
  const ns = models();
  const { picker, doc, container } = elements();
  doc.querySelectorAll = selector => selector === ns.proUsageModel.SELECTORS ? [picker] : [];
  assert.equal(ns.proUsageModel.detect(doc)?.id, "gpt-6-pro", "原有计数识别仍可使用明确的模型入口");
  assert.equal(ns.proUsageModel.detect(doc, { composerOnly: true }), null);
  const badge = new ns.ProModelBadge({ documentRef: doc, host: "chatgpt.com", Observer: null });
  badge.setSettings({ trackProUsage: true, proPlan: "business-standard" });
  assert.equal(container.inserted.length, 0, "用户要求只在输入框 Pro 旁显示");
});

test("输入框采用 footer 容器时仍识别其右侧 Pro 控件", () => {
  const ns = models();
  const { picker, doc } = elements();
  const editor = doc.querySelectorAll(ns.proUsageModel.COMPOSER_EDITOR_SELECTOR)[0];
  editor.parentElement.tagName = "FOOTER";
  assert.equal(ns.proUsageModel.detect(doc, { composerOnly: true })?.element, picker);
});

test("数字按 Pro 文字范围定位，而不是按钮包含箭头与留白的整个范围", () => {
  const ns = models();
  const expected = { left: 100, right: 125, top: 200, bottom: 220, width: 25, height: 20 };
  const node = { nodeValue: "GPT-6 Pro", parentElement: { closest() { return null; } } };
  let next = true, offsets;
  const doc = {
    createTreeWalker() { return { nextNode() { if (!next) return null; next = false; return node; } }; },
    createRange() { return {
      setStart(target, from) { offsets = [target, from]; },
      setEnd(target, to) { offsets.push(target, to); },
      getBoundingClientRect() { return expected; }
    }; }
  };
  const target = { getBoundingClientRect() { return { ...expected, right: 190, width: 90 }; } };
  assert.equal(ns.proBadgeModel.proLabelRect(doc, target), expected);
  assert.equal(offsets[1], 6);
  assert.equal(offsets[3], 9);
});

test("页面普通 Console 可读 Pro 诊断状态，但不泄漏计数和用户资料", () => {
  const ns = models();
  const { doc, picker } = elements();
  const badge = new ns.ProModelBadge({ documentRef: doc, host: "chatgpt.com", Observer: null });
  badge.setSettings({ trackProUsage: false, proPlan: "pro-100" });
  assert.equal(doc.documentElement.getAttribute("data-aih-pro-state"), "disabled");
  badge.setSettings({ trackProUsage: true, proPlan: "pro-100" });
  assert.equal(doc.documentElement.getAttribute("data-aih-pro-state"), "shown");
  picker.textContent = "Instant";
  badge.render();
  assert.equal(doc.documentElement.getAttribute("data-aih-pro-state"), "no-pro-control");
  doc.picker = null;
  badge.render();
  assert.equal(doc.documentElement.getAttribute("data-aih-pro-state"), "no-pro-control");
  const value = [...["data-aih-pro-state", "data-aih-pro-version"]].map((key) =>
    doc.documentElement.getAttribute(key)).join(" ");
  assert.doesNotMatch(value, /prompt|token|requestId|@|SECRET/);
});

test("Pro 模型框内使用括号，无插件提示且保留数据来源标记", () => {
  const ns = models();
  const { picker, doc } = elements();
  const now = new Date(2026, 9, 22, 13).getTime();
  const badge = new ns.ProModelBadge({
    documentRef: doc, host: "chatgpt.com", Observer: null, now: () => now
  });
  badge.updateUsage(usage(1, now));
  badge.setSettings({ trackProUsage: true, proPlan: "business-standard" });
  assert.equal(badge.badge.textContent, "(14)");
  assert.equal(badge.badge.getAttribute("data-aih-pro-source"), "estimated");
  assert.equal(badge.badge.title, "", "悬停不应该出现扩展提示");
  assert.equal(badge.badge.getAttribute("aria-hidden"), "true");

  badge.updateQuota({ "gpt-6-pro": {
    status: "remaining-shown", source: "chatgpt-visible-ui", remaining: 7, observedAt: now - 1000, resetAt: now + 1800000
  } });
  assert.equal(badge.badge.textContent, "(7)");
  assert.equal(badge.badge.getAttribute("data-aih-pro-source"), "ui");
  assert.equal(badge.badge.title, "", "页面确认的数字也不弹出提示");

  badge.updateQuota(null);
  picker.textContent = "Pro";
  badge.setSettings({ trackProUsage: true, proPlan: "pro-200" });
  assert.equal(badge.badge.textContent, "(≤199)", "共享上限不得假装成精确可用次数");
  assert.equal(badge.badge.getAttribute("data-aih-pro-source"), "upper-bound");
  assert.equal(badge.badge.title, "", "额度上限通过 ≤ 符号表达，不弹额外说明");

  badge.setSettings({ trackProUsage: true, proPlan: "unknown" });
  assert.equal(badge.badge.textContent, "(?)");
  assert.equal(badge.badge.getAttribute("data-aih-pro-source"), "unknown");
});
