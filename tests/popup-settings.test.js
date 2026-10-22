const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const source = fs.readFileSync(path.join(__dirname, "..", "popup", "popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup", "index.html"), "utf8");

test("ChatGPT 专属设置集中在独立分组框中", () => {
  const generalStart = popupHtml.indexOf('<section class="settings">');
  const chatgptStart = popupHtml.indexOf('<section class="chatgpt-settings">');
  const domainsStart = popupHtml.indexOf('<section class="domains">');
  assert.ok(generalStart >= 0 && chatgptStart > generalStart && domainsStart > chatgptStart);
  const generalBlock = popupHtml.slice(generalStart, chatgptStart);
  const chatgptBlock = popupHtml.slice(chatgptStart, domainsStart);
  assert.doesNotMatch(generalBlock, /trackRequestTime|notifyEnabled/);
  assert.match(chatgptBlock, /chatgpt\.title/);
  assert.match(chatgptBlock, /trackRequestTime/);
  assert.match(chatgptBlock, /notifyEnabled/);
  assert.match(chatgptBlock, /notifyAvailableTimes/);
  assert.match(chatgptBlock, /addNotifyAvailableTime/);
  assert.ok(chatgptBlock.indexOf("trackRequestTime") < chatgptBlock.indexOf("notifyEnabled"));
});

function element() {
  const listeners = {};
  const classes = new Set();
  return {
    listeners,
    open: false,
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    style: {},
    validity: { valid: true },
    addEventListener(type, listener) { listeners[type] = listener; },
    appendChild() {},
    replaceChildren() {},
    setAttribute() {},
    focus() {},
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
}

test("计时诊断可按会话筛选并导出脱敏 JSON，界面无须开启第三方通知", () => {
  assert.match(popupHtml, /id="notificationDebugFilter"/);
  assert.match(popupHtml, /id="exportNotificationDebug"/);
  assert.match(source, /notificationDebugFilter\.addEventListener\("input", renderNotificationDebugLog\)/);
  assert.match(source, /function exportNotificationDebugLog\(/);
  assert.match(source, /AIInputHistory-Diagnostics-v1/);
  assert.match(source, /activeSessions: Array\.isArray\(result\.activeSessions\)/);
  assert.match(source, /download = `AIInputHistory-diagnostics-/);
});

async function createPopupHarness(initialSettings = {}) {
  const elements = Object.fromEntries([
    "#historyLimit", "#sendLimit", "#snapshotSeconds", "#launcherEnabled", "#domainInput", "#trackRequestTime", "#trackProUsage", "#proPlan",
    "#notifyEnabled", "#notifyProvider", "#notifyMinDurationSeconds", "#notifyAvailableTimes", "#addNotifyAvailableTime", "#testNotification", "#notifyBarkUrl", "#notifyServerChanKey", "#notifyPushPlusToken",
    "#notifyNtfyUrl", "#notifyNtfyTopic", "#notifyGotifyUrl", "#notifyGotifyToken", "#notifyDingtalkWebhook", "#notifyFeishuWebhook", "#notifyWecomWebhook", "#notifyCustomMethod", "#notifyCustomUrl", "#notifyCustomHeaders", "#notifyCustomBody",
    "#notificationDebugLog", "#notificationDebugFilter", "#refreshNotificationDebug", "#copyNotificationDebug", "#exportNotificationDebug", "#clearNotificationDebug",
    "#clearConversationStats", "#conversationStatsList", "#conversationTotal", "#conversationToday", "#conversationWeek", "#conversationMonth",
    "#proUsageTotal", "#proUsageToday", "#proUsageWeek", "#proUsageMonth", "#proUsageModels",
    "#proUsageRecent", "#proUsageResetAt", "#proUsagePeriods", "#proUsageTimeline", "#resetProUsage", "#proQuotaStatus",
    "#proUsageSection", "#proUsageSettings", "#detectProPlan", "#proPlanDetection", "#proPlanAllowance",
    "#domainList", "#domainForm", "#clear", "#status", "#totalCount", "#sendCount", "#draftCount",
    "#shortcutCapture", "#shortcutDisable", "#languageSelect", "#clearDialog", "#clearDialogError", "#cancelClear", "#confirmClear", "#extensionVersion"
  ].map((selector) => [selector, element()]));
  const saves = [];
  let clearCount = 0;
  let clearStatsCount = 0;
  const resetRequests = [];
  let currentSettings = null;
  class HistoryStore {
    async getSettings() {
      if (currentSettings) return currentSettings;
      return {
        historyLimit: 100, sendLimit: 10, snapshotSeconds: 60, shortcut: "Ctrl+R", language: "zh-CN", launcherEnabled: true, trackRequestTime: false, trackProUsage: false, proPlan: "unknown",
        completionNotification: { enabled: false, provider: "browser", minDurationSeconds: 20, availableTimes: [], barkUrl: "", serverChanKey: "", pushPlusToken: "", ntfyUrl: "https://ntfy.sh", ntfyTopic: "", gotifyUrl: "", gotifyToken: "", dingtalkWebhook: "", feishuWebhook: "", wecomWebhook: "", customMethod: "POST", customUrl: "", customHeaders: "{}", customBody: '{"title":"{{title}}","message":"{{message}}"}' },
        customDomains: [], ...initialSettings
      };
    }
    async getState() { return { entries: [], drafts: {} }; }
    async getSendStats() { return { all: { total: 0, today: 0, thisWeek: 0, thisMonth: 0 }, rows: [] }; }
    async getProUsageStats() { return { all: { total: 0, today: 0, thisWeek: 0, thisMonth: 0 }, rows: [] }; }
    async getProQuotaStatus() { return {}; }
    async patchSettings(patch) {
      if (context.patchFailure) throw new Error("storage-write-failed");
      if (context.pauseSettingsSave) await context.pauseSettingsSave;
      saves.push(patch);
      currentSettings = { ...await this.getSettings(), ...patch,
        snapshotSeconds: Number(patch.snapshotSeconds || (await this.getSettings()).snapshotSeconds || 60) };
      return currentSettings;
    }
    async clearHistory() { clearCount += 1; }
    async clearSendStats() { clearStatsCount += 1; }
  }
  const context = {
    chrome: {
      runtime: { lastError: null, getManifest: () => ({ version: "1.26.0" }), sendMessage(message, callback) {
        if (message.type === "AIH_PRO_USAGE_RESET") resetRequests.push(message);
        callback({ ok: true, type: message.type });
      } },
      permissions: { request(request, callback) { context.permissionRequests.push(request); callback(true); } },
      storage: { onChanged: { addListener(listener) { context.storageListener = listener; } }
      },
      tabs: {
        query(options, callback) {
          callback(options.active ? (context.mockActiveTabs || [{ id: 42 }])
            : context.mockAllTabs || [{ id: 42 }]);
        },
        sendMessage(tabId, message, callback) {
          context.planLookupMessages.push({ tabId, message });
          if (context.holdPlanReads) {
            (context.pendingPlanCallbacks ||= []).push(callback);
            return;
          }
          callback(context.mockPlanResponses?.[tabId] || context.mockPlanResponse || {
            ok: true, plan: "pro-unverified", planType: "pro",
            precise: false, source: "chatgpt-session"
          });
        }
      }
    },
    permissionRequests: [],
    planLookupMessages: [],
    AIInputHistory: { HistoryStore, i18n: (() => {
      let language = "zh-CN";
      return { setLanguage(value) { language = value === "en" ? "en" : "zh-CN"; }, language: () => language, locale: () => language === "en" ? "en-US" : "zh-CN", localize() {}, t: (key) => key };
    })(), historyModel: {
      shortcutFromEvent(event) { return event.ctrlKey && event.code === "KeyK" ? "Ctrl+K" : ""; },
      normalizeDomain() { return ""; },
      sanitizeSettings(value) { return value; }
    }, conversationStatsModel: {
      summarize() { return { all: { total: 0, today: 0, thisWeek: 0, thisMonth: 0 }, rows: [] }; }
    }, proUsageModel: {
      summarize() { return { all: { total: 0, today: 0, thisWeek: 0, thisMonth: 0 }, rows: [] }; },
      MODEL_LABELS: {},
      PLAN_LABELS: { unknown: "unknown", "pro-unverified": "Pro",
        "business-unverified": "Business", "pro-100": "Pro $100",
        "business-standard": "Business Standard",
        "business-premium": "Business Premium" },
      allowanceOverview() { return { usedThisMonth: 0, monthlyCap: null, weeklyOrDaily: false }; },
      remainingEstimate() { return null; }
    }, proQuotaModel: {
      activeStatus() { return null; }
    }, SiteProfiles: { PROFILES: [], icon: () => "", displayName: (site) => site }, STORAGE_KEYS: { settings: "settings", state: "state", sendStats: "sendStats", proUsage: "proUsage", proQuota: "proQuota" } },
    document: {
      documentElement: { lang: "" },
      querySelector: (selector) => elements[selector],
      querySelectorAll: () => [],
      createElement: () => element(),
      createTextNode: (text) => ({ text })
    },
    setTimeout: () => 1,
    clearTimeout() {},
    console: { error() {}, warn() {}, log() {} }
  };
  context.globalThis = context;
  await vm.runInNewContext(source, context);
  return { elements, saves, context, resetRequests, HistoryStore,
    get clearCount() { return clearCount; },
    get clearStatsCount() { return clearStatsCount; } };
}

test("修改自动快照秒数时无需关闭输入框即可立即保存", async () => {
  const harness = await createPopupHarness();
  const { elements, saves, context, resetRequests, HistoryStore } = harness;
  assert.equal(elements["#notifyProvider"].disabled, true);
  assert.equal(elements["#notifyMinDurationSeconds"].disabled, true);
  assert.equal(elements["#addNotifyAvailableTime"].disabled, true);
  assert.equal(elements["#notifyMinDurationSeconds"].value, 20);
  assert.equal(elements["#testNotification"].disabled, true);
  assert.equal(elements["#notifyNtfyUrl"].disabled, true);

  // Pro usage has its own live counter, separate from ordinary send statistics.
  context.AIInputHistory.proUsageModel.summarize = () => ({
    all: { total: 4, today: 2, thisWeek: 3, thisMonth: 4 },
    rows: [{ label: "GPT-6 Pro", total: 4, today: 2, thisWeek: 3, thisMonth: 4 }]
  });
  context.storageListener({ proUsage: { newValue: { version: 1 } } }, "local");
  assert.equal(elements["#proUsageTotal"].textContent, 4);
  assert.equal(elements["#proUsageToday"].textContent, 2);
  assert.equal(elements["#proUsageWeek"].textContent, 3);
  assert.equal(elements["#proUsageMonth"].textContent, 4);
  assert.equal(typeof elements["#proUsagePeriods"].listeners.click, "function");
  elements["#proUsagePeriods"].listeners.click({
    target: { closest: () => ({ dataset: { proPeriod: "week" } }) }
  });
  let resetConfirm = false;
  context.confirm = () => resetConfirm;
  await elements["#resetProUsage"].listeners.click();
  assert.equal(resetRequests.length, 0, "确认取消后不应重置");
  resetConfirm = true;
  await elements["#resetProUsage"].listeners.click();
  assert.equal(resetRequests.length, 1, "确认后应该调用后台本地重置");
  assert.equal(elements["#resetProUsage"].disabled, false, "重置后按钮应重新启用");

  const snapshotInput = elements["#snapshotSeconds"];
  snapshotInput.value = "5";
  snapshotInput.listeners.input();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(saves.at(-1).snapshotSeconds, "5");
  elements["#trackProUsage"].checked = true;
  elements["#trackProUsage"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.findLast(patch => "trackProUsage" in patch).trackProUsage, true);
  assert.equal(context.planLookupMessages.length, 1, "开启 Pro 自动读取一次套餐");
  assert.equal(elements["#proUsageSection"].hidden, false);
  assert.equal(elements["#proUsageSettings"].hidden, false);
  assert.equal(saves.at(-1).trackRequestTime, undefined, "Pro 开关不应修改耗时设置");
  elements["#proPlan"].value = "business-premium";
  elements["#proPlan"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).proPlan, "business-premium");
  assert.equal(saves.at(-1).trackRequestTime, undefined,
    "手动套餐选择不应修改耗时开关");

  // Session API can say only generic Pro; preserve the manual exact choice.
  await elements["#detectProPlan"].listeners.click();
  assert.equal(context.planLookupMessages.length, 2, "自动读取后仍可点击手动重新读取");
  assert.equal(context.planLookupMessages[0].tabId, 42);
  assert.equal(context.planLookupMessages[0].message.type, "AIH_PRO_ACCOUNT_PLAN_READ");
  assert.equal(saves.at(-1).proPlan, "business-premium",
    "只有泛化 Pro 的读取结果不能覆盖已经手动确认的精确档位");
  context.mockPlanResponse = { ok: true, plan: "pro-100", planType: "pro-100",
    precise: true, source: "chatgpt-session" };
  await elements["#detectProPlan"].listeners.click();
  assert.equal(saves.at(-1).proPlan, "pro-100", "精确匹配的套餐应自动选中");
  assert.equal(elements["#proPlan"].value, "pro-100");

  // If the active page is not ChatGPT, try other open tabs without URL
  // permissions. An inactive signed-in ChatGPT tab should still work.
  context.mockAllTabs = [{ id: 42 }, { id: 77 }];
  context.mockPlanResponses = {
    42: { ok: false, reason: "no-content-script" },
    77: { ok: true, plan: "business-premium", planType: "business-premium",
      precise: true, source: "chatgpt-account-list" }
  };
  await elements["#detectProPlan"].listeners.click();
  assert.equal(context.planLookupMessages.at(-1).tabId, 77);
  assert.equal(saves.at(-1).proPlan, "business-premium");
  assert.match(elements["#proPlanDetection"].textContent, /proUsage.detectOtherTab/);

  // A legacy "default" Business seat now resolves to Standard, but this
  // compatibility alias cannot silently replace a manually chosen Premium.
  context.mockAllTabs = [{ id: 42 }];
  context.mockPlanResponses = { 42: {
    ok: true, plan: "business-standard", type: "business", precise: false,
    seatMapping: "legacy-default-as-standard", seatTypeCode: "default",
    source: "chatgpt-member-seat"
  } };
  await elements["#detectProPlan"].listeners.click();
  assert.equal(saves.at(-1).proPlan, "business-premium",
    "a legacy compatibility alias must not overwrite manually chosen Premium");
  assert.match(elements["#proPlanDetection"].textContent, /proUsage.detectLegacyDefault/,
    "show that the detected Standard plan is based on a legacy alias");
  assert.match(elements["#proPlanDetection"].textContent, /proUsage.manualPlanPreserved/,
    "explain why the dropdown remains on the manually selected Premium tier");
  elements["#proPlan"].value = "business-unverified";
  elements["#proPlan"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  await elements["#detectProPlan"].listeners.click();
  assert.equal(saves.at(-1).proPlan, "business-standard",
    "with no known seat tier, legacy default should automatically select Standard");
  elements["#proPlan"].value = "business-premium";
  elements["#proPlan"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));

  // Generic Business with an unusable member API remains unverified but
  // explains *why*, rather than pretending workspace plan_type is a seat.
  context.mockAllTabs = [{ id: 42 }];
  context.mockPlanResponses = {
    42: { ok: true, plan: "business-unverified", type: "business",
      precise: false, source: "chatgpt-account-list", seatReason: "seat-http-403" }
  };
  await elements["#detectProPlan"].listeners.click();
  assert.match(elements["#proPlanDetection"].textContent, /proUsage.seatDenied/);
  assert.equal(saves.at(-1).proPlan, "business-premium",
    "generic workspace must not overwrite a manually selected Premium seat");

  // Specific safe error codes must appear instead of one generic failure.
  context.mockAllTabs = [{ id: 42 }];
  context.mockPlanResponses = { 42: { ok: false, reason: "session-http-403" } };
  await elements["#detectProPlan"].listeners.click();
  assert.match(elements["#proPlanDetection"].textContent, /session-http-403/);
  assert.equal(saves.at(-1).proPlan, "business-premium",
    "a failed lookup must not overwrite the manually/previously chosen plan");
  assert.equal(elements["#detectProPlan"].disabled, false);

  elements["#trackProUsage"].checked = false;
  elements["#trackProUsage"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["#proUsageSection"].hidden, true);
  assert.equal(elements["#proUsageSettings"].hidden, true);
  assert.equal(saves.at(-1).trackProUsage, false);
  assert.equal(saves.at(-1).trackRequestTime, undefined, "套餐切换不应修改耗时开关");
  elements["#trackRequestTime"].checked = true;
  elements["#trackRequestTime"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).trackRequestTime, true);
  assert.equal(saves.at(-1).trackProUsage, undefined, "耗时开关不应更改 Pro 计数");

  const shortcutCapture = elements["#shortcutCapture"];
  shortcutCapture.listeners.click();
  shortcutCapture.listeners.keydown({ key: "k", code: "KeyK", ctrlKey: true, preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).shortcut, "Ctrl+K");

  elements["#languageSelect"].value = "en";
  elements["#languageSelect"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).language, "en");
  assert.equal(context.document.documentElement.lang, "en");
  assert.equal(elements["#extensionVersion"].textContent, "v1.26.0");
  context.storageListener({ settings: { newValue: { ...await new HistoryStore().getSettings(), launcherEnabled: false } } }, "local");
  assert.equal(elements["#launcherEnabled"].checked, false);
  elements["#trackRequestTime"].checked = true;
  elements["#trackRequestTime"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).trackRequestTime, true);
  assert.deepEqual(Object.keys(saves[0]), ["snapshotSeconds"]);

  elements["#notifyEnabled"].checked = true;
  elements["#notifyEnabled"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.permissionRequests.at(-1).permissions[0], "notifications");
  assert.equal(saves.at(-1).completionNotification.enabled, true);
  assert.equal(saves.at(-1).completionNotification.provider, "browser");
  assert.equal(elements["#notifyProvider"].disabled, false);
  assert.equal(elements["#notifyMinDurationSeconds"].disabled, false);
  assert.equal(elements["#addNotifyAvailableTime"].disabled, false);
  assert.equal(elements["#testNotification"].disabled, false);
  assert.equal(elements["#notifyNtfyUrl"].disabled, false);

  elements["#notifyMinDurationSeconds"].value = "30";
  elements["#notifyMinDurationSeconds"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saves.at(-1).completionNotification.minDurationSeconds, "30");

  elements["#notifyEnabled"].checked = false;
  elements["#notifyEnabled"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements["#notifyProvider"].disabled, true);
  assert.equal(elements["#notifyMinDurationSeconds"].disabled, true);
  assert.equal(elements["#addNotifyAvailableTime"].disabled, true);
  assert.equal(elements["#testNotification"].disabled, true);
  assert.equal(elements["#notifyNtfyUrl"].disabled, true);

  await elements["#clearConversationStats"].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.clearStatsCount, 1);
  assert.equal(harness.clearCount, 0);

  // Export stays usable even when completion notifications are disabled.
  const downloaded = {};
  context.Blob = class {
    constructor(parts, options) { downloaded.json = parts.join(""); downloaded.type = options.type; }
  };
  context.URL = { createObjectURL: () => "blob:diagnostic", revokeObjectURL() {} };
  const fakeAnchor = { href: "", download: "", click() { downloaded.clicked = true; }, remove() {} };
  context.document.body = { appendChild() {} };
  context.document.createElement = () => fakeAnchor;
  await elements["#exportNotificationDebug"].listeners.click();
  assert.equal(downloaded.clicked, true, "点击按钮应触发浏览器下载");
  assert.match(fakeAnchor.download, /^AIInputHistory-diagnostics-.*\.json$/);
  assert.equal(JSON.parse(downloaded.json).format, "AIInputHistory-Diagnostics-v1");
  assert.equal(downloaded.type, "application/json");

  elements["#clear"].listeners.click();
  assert.equal(elements["#clearDialog"].open, true);
  assert.equal(harness.clearCount, 0);
  elements["#cancelClear"].listeners.click();
  assert.equal(elements["#clearDialog"].open, false);
  elements["#clear"].listeners.click();
  await elements["#confirmClear"].listeners.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.clearCount, 1);
});

const flushPopup = () => new Promise(resolve => setImmediate(resolve));
const exactPlan = { ok: true, plan: "pro-100", precise: true, source: "chatgpt-session" };
function changePro(harness, enabled) {
  harness.elements["#trackProUsage"].checked = enabled;
  return harness.elements["#trackProUsage"].listeners.change();
}

test("开启 Pro 后自动读取当前套餐并保存，初始化和重复开启不查询", async () => {
  const h = await createPopupHarness();
  h.context.mockPlanResponse = exactPlan;
  assert.equal(h.context.planLookupMessages.length, 0);
  await changePro(h, true);
  assert.equal(h.context.planLookupMessages.length, 1);
  assert.equal(h.saves[0].trackProUsage, true, "先保存开关，再读取套餐");
  assert.equal(h.elements["#proPlan"].value, "pro-100");
  assert.equal((await new h.HistoryStore().getSettings()).proPlan, "pro-100");
  assert.equal(h.elements["#detectProPlan"].disabled, false);
  await changePro(h, true);
  assert.equal(h.context.planLookupMessages.length, 1, "相同状态事件不应重复读");
  await changePro(h, false);
  assert.equal(h.context.planLookupMessages.length, 1, "关闭不读取");
  await changePro(h, true);
  assert.equal(h.context.planLookupMessages.length, 2, "再次主动开启可以重新查询");
});

test("已有开启状态时打开设置及同步其他设置不自动查账号", async () => {
  const h = await createPopupHarness({ trackProUsage: true, proPlan: "business-standard" });
  assert.equal(h.context.planLookupMessages.length, 0);
  h.context.storageListener({ settings: { newValue: {
    ...await new h.HistoryStore().getSettings(), language: "en"
  } } }, "local");
  await flushPopup();
  assert.equal(h.context.planLookupMessages.length, 0);
  await changePro(h, false);
  assert.equal(h.context.planLookupMessages.length, 0);
});

test("同一开启动作的重复事件仍只发起一次自动读取", async () => {
  const h = await createPopupHarness();
  h.context.mockPlanResponse = exactPlan;
  await Promise.all([changePro(h, true), changePro(h, true)]);
  assert.equal(h.context.planLookupMessages.length, 1);
  assert.equal(h.elements["#proPlan"].value, "pro-100");
});

test("自动读取失败不关闭统计或清空已确认的套餐", async () => {
  const h = await createPopupHarness({ proPlan: "business-premium" });
  h.context.mockPlanResponse = { ok: false, reason: "session-http-403" };
  await changePro(h, true);
  const settings = await new h.HistoryStore().getSettings();
  assert.equal(settings.trackProUsage, true);
  assert.equal(settings.proPlan, "business-premium");
  assert.match(h.elements["#proPlanDetection"].textContent, /session-http-403/);
  assert.equal(h.elements["#detectProPlan"].disabled, false);
  assert.equal(h.resetRequests.length, 0);
});

test("没有 ChatGPT 标签页时保留套餐并允许手动重试", async () => {
  const h = await createPopupHarness({ proPlan: "business-standard" });
  h.context.mockActiveTabs = [];
  h.context.mockAllTabs = [];
  await changePro(h, true);
  assert.equal(h.context.planLookupMessages.length, 0);
  assert.match(h.elements["#proPlanDetection"].textContent, /no-chatgpt-tab/);
  assert.equal((await new h.HistoryStore().getSettings()).proPlan, "business-standard");
  h.context.mockActiveTabs = [{ id: 42 }];
  h.context.mockPlanResponse = exactPlan;
  await h.elements["#detectProPlan"].listeners.click();
  assert.equal(h.context.planLookupMessages.length, 1);
  assert.equal(h.elements["#proPlan"].value, "pro-100");
});

test("Pro 开关保存失败时不发起账号读取，稍后重试仍可触发", async () => {
  const h = await createPopupHarness();
  h.context.patchFailure = true;
  await changePro(h, true);
  assert.equal(h.context.planLookupMessages.length, 0);
  assert.equal((await new h.HistoryStore().getSettings()).trackProUsage, false);
  h.context.patchFailure = false;
  h.context.mockPlanResponse = exactPlan;
  await changePro(h, true);
  assert.equal(h.context.planLookupMessages.length, 1);
  assert.equal(h.elements["#proPlan"].value, "pro-100");
});

test("关闭 Pro 时尚未完成的自动读取不得回写套餐", async () => {
  const h = await createPopupHarness({ proPlan: "business-premium" });
  h.context.holdPlanReads = true;
  const reading = changePro(h, true);
  await flushPopup();
  assert.equal(h.context.pendingPlanCallbacks.length, 1);
  await changePro(h, false);
  h.context.pendingPlanCallbacks[0](exactPlan);
  await reading;
  assert.equal((await new h.HistoryStore().getSettings()).trackProUsage, false);
  assert.equal(h.elements["#proPlan"].value, "business-premium");
  assert.equal(h.elements["#detectProPlan"].disabled, false);
});

test("用户读取途中手动选套餐，迟到的精确读取结果也不能覆盖", async () => {
  const h = await createPopupHarness();
  h.context.holdPlanReads = true;
  const reading = changePro(h, true);
  await flushPopup();
  h.elements["#proPlan"].value = "business-premium";
  await h.elements["#proPlan"].listeners.change();
  h.context.pendingPlanCallbacks[0](exactPlan);
  await reading;
  assert.equal(h.elements["#proPlan"].value, "business-premium");
  assert.equal(h.elements["#proPlanDetection"].textContent, "proUsage.planManual");
});

test("自动读取和手动按钮并发时共享一次请求", async () => {
  const h = await createPopupHarness();
  h.context.holdPlanReads = true;
  const automatic = changePro(h, true);
  await flushPopup();
  const manual = h.elements["#detectProPlan"].listeners.click();
  await flushPopup();
  assert.equal(h.context.planLookupMessages.length, 1);
  h.context.pendingPlanCallbacks[0](exactPlan);
  await Promise.all([automatic, manual]);
  assert.equal(h.elements["#proPlan"].value, "pro-100");
  assert.equal(h.elements["#detectProPlan"].disabled, false);
});

test("自动读取途中快速关再开复用请求，但仅当前开启动作接收结果", async () => {
  const h = await createPopupHarness();
  h.context.holdPlanReads = true;
  const first = changePro(h, true);
  await flushPopup();
  await changePro(h, false);
  const last = changePro(h, true);
  await flushPopup();
  assert.equal(h.context.planLookupMessages.length, 1);
  h.context.pendingPlanCallbacks[0](exactPlan);
  await Promise.all([first, last]);
  assert.equal(h.elements["#proPlan"].value, "pro-100");
  assert.equal((await new h.HistoryStore().getSettings()).trackProUsage, true);
});

test("开启保存尚未完成即关闭，不应发送套餐查询", async () => {
  const h = await createPopupHarness();
  let finishSave;
  h.context.pauseSettingsSave = new Promise(resolve => { finishSave = resolve; });
  const enable = changePro(h, true);
  const disable = changePro(h, false);
  finishSave();
  await Promise.all([enable, disable]);
  assert.equal(h.context.planLookupMessages.length, 0);
  assert.equal((await new h.HistoryStore().getSettings()).trackProUsage, false);
});

test("自动读取泛化套餐时仍保留已有精确档位", async () => {
  const h = await createPopupHarness({ proPlan: "business-premium" });
  h.context.mockPlanResponse = { ok: true, plan: "business-unverified", precise: false };
  await changePro(h, true);
  assert.equal(h.context.planLookupMessages.length, 1);
  assert.equal(h.elements["#proPlan"].value, "business-premium");
  assert.equal(h.saves.filter(patch => "proPlan" in patch).length, 0);
});
