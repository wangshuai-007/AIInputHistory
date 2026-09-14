"use strict";

if (typeof importScripts === "function") importScripts("src/completion-notification.js");

const LOCK_TIMEOUT_MS = 15_000;
const TIMING_SESSION_KEY = "aiInputHistoryActiveTimingByUrl";
const TIMING_MAX_AGE_MS = 30 * 60 * 1000;
const NOTIFICATION_DEBUG_KEY = "aiInputHistoryNotificationDebugLog";
const NOTIFICATION_DEBUG_LIMIT = 100;
const waiters = [];
let ownerToken = "";
let ownerTimer = null;
let timingSessionQueue = Promise.resolve();
let notificationDebugQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "AIH_STORAGE_LOCK_ACQUIRE") {
    waiters.push({ sendResponse, senderId: sender.tab?.id ?? "extension" });
    grantNext();
    return true;
  }

  if (message?.type === "AIH_STORAGE_LOCK_RELEASE") {
    const released = message.token === ownerToken;
    if (released) releaseOwner();
    sendResponse({ released });
    return false;
  }

  if (["AIH_TIMING_SESSION_SAVE", "AIH_TIMING_SESSION_LOAD", "AIH_TIMING_SESSION_CLEAR"].includes(message?.type)) {
    handleTimingSessionMessage(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "AIH_NOTIFICATION_DEBUG_APPEND") {
    appendNotificationDebug({ ...message.entry, sourceTabId: sender.tab?.id ?? null })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "AIH_NOTIFICATION_DEBUG_GET") {
    storageGet(NOTIFICATION_DEBUG_KEY)
      .then((logs) => sendResponse({ ok: true, logs: Array.isArray(logs) ? logs : [] }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "AIH_NOTIFICATION_DEBUG_CLEAR") {
    storageSet({ [NOTIFICATION_DEBUG_KEY]: [] })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "AIH_REQUEST_COMPLETED" || message?.type === "AIH_NOTIFICATION_TEST") {
    const isTest = message.type === "AIH_NOTIFICATION_TEST";
    const traceId = `${Date.now()}-${crypto.randomUUID()}`;
    const event = isTest ? {
      promptText: "这是一条 ChatGPT 回复完成测试通知",
      durationMs: 3200, completedAt: Date.now(), pageUrl: "https://chatgpt.com/"
    } : message.event;
    appendNotificationDebug({
      traceId, stage: "event-received", type: message.type, isTest,
      durationMs: Number.isFinite(event?.durationMs) ? event.durationMs : null,
      notificationEligible: event?.notificationEligible !== false,
      detectionTrigger: event?.detectionTrigger || null,
      visibility: message?.visibility || null,
      page: safePageRef(event?.pageUrl), sourceTabId: sender.tab?.id ?? null
    })
      .then(() => deliverConfiguredNotification(event, { ignoreMinimumDuration: isTest, traceId }))
      .then(async (result) => {
        if (isTest && result?.skipped) throw new Error("完成通知尚未开启或设置尚未保存");
        await appendNotificationDebug({ traceId, stage: "delivery-finished", ...summarizeDeliveryResult(result) });
        sendResponse({ ok: true, ...result });
      })
      .catch(async (error) => {
        await appendNotificationDebug({ traceId, stage: "delivery-error", error: safeError(error) });
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  return false;
});

function grantNext() {
  if (ownerToken || !waiters.length) return;
  const waiter = waiters.shift();
  ownerToken = `${Date.now()}-${crypto.randomUUID()}`;
  ownerTimer = setTimeout(releaseOwner, LOCK_TIMEOUT_MS);
  waiter.sendResponse({ token: ownerToken, senderId: waiter.senderId });
}

function releaseOwner() {
  clearTimeout(ownerTimer);
  ownerTimer = null;
  ownerToken = "";
  grantNext();
}

function storageGet(key) {
  return new Promise((resolve, reject) => chrome.storage.local.get(key, (result) => {
    const error = chrome.runtime.lastError;
    error ? reject(error) : resolve(result[key]);
  }));
}

function storageSet(value) {
  return new Promise((resolve, reject) => chrome.storage.local.set(value, () => {
    const error = chrome.runtime.lastError;
    error ? reject(error) : resolve();
  }));
}

function safePageRef(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.hostname}${url.pathname}`;
  } catch { return ""; }
}

function safeEndpointRef(value) {
  try { return new URL(String(value || "")).hostname; }
  catch { return ""; }
}

function safeError(error) {
  return String(error?.message || error || "").replace(/https?:\/\/\S+/g, "[url]").slice(0, 240);
}

function sanitizeNotificationDebugEntry(entry = {}) {
  const allowed = ["traceId", "stage", "type", "isTest", "provider", "enabled", "minDurationSeconds", "durationMs",
    "notificationEligible", "detectionTrigger", "visibility", "page", "sourceTabId", "deliveryKind", "endpointHost", "httpStatus", "skipped", "reason", "error"];
  const result = { at: Date.now() };
  allowed.forEach((key) => {
    const value = entry[key];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) result[key] = value;
  });
  return result;
}

function appendNotificationDebug(entry = {}) {
  const record = sanitizeNotificationDebugEntry(entry);
  console.info("[AI Input History][通知调试]", record);
  const operation = async () => {
    const current = await storageGet(NOTIFICATION_DEBUG_KEY);
    const logs = Array.isArray(current) ? current.slice(-NOTIFICATION_DEBUG_LIMIT + 1) : [];
    logs.push(record);
    await storageSet({ [NOTIFICATION_DEBUG_KEY]: logs });
  };
  const task = notificationDebugQueue.then(operation, operation);
  notificationDebugQueue = task.catch((error) => console.warn("[AI Input History] 保存通知调试日志失败", error));
  return task;
}

function summarizeDeliveryResult(result = {}) {
  return {
    provider: result.provider || null, deliveryKind: result.deliveryKind || null,
    skipped: result.skipped === true, reason: result.reason || null,
    minDurationSeconds: Number.isFinite(result.minDurationSeconds) ? result.minDurationSeconds : null,
    httpStatus: Number.isFinite(result.httpStatus) ? result.httpStatus : null
  };
}

function timingUrlKey(site, path) {
  const host = String(site || "").trim().toLowerCase();
  const pathname = String(path || "").trim();
  if (!host || !pathname.startsWith("/")) throw new Error("请求计时会话缺少有效 URL");
  return `${host}${pathname}`;
}

async function handleTimingSessionMessage(message) {
  const operation = async () => {
    const now = Date.now();
    const stored = await storageGet(TIMING_SESSION_KEY) || {};
    const states = Object.fromEntries(Object.entries(stored).filter(([, value]) =>
      Number.isFinite(value?.startedAt) && now - value.startedAt <= TIMING_MAX_AGE_MS));
    if (message.type === "AIH_TIMING_SESSION_SAVE") {
      const state = message.state || {};
      if (!state.requestId) throw new Error("请求计时会话缺少 requestId");
      for (const [key, value] of Object.entries(states)) {
        if (value?.requestId === state.requestId) delete states[key];
      }
      states[timingUrlKey(state.site, state.path)] = { ...state, savedAt: now };
    }
    if (message.type === "AIH_TIMING_SESSION_CLEAR") {
      if (message.requestId) {
        for (const [key, value] of Object.entries(states)) {
          if (value?.requestId === message.requestId) delete states[key];
        }
      } else if (message.site && message.path) delete states[timingUrlKey(message.site, message.path)];
    }
    const state = message.type === "AIH_TIMING_SESSION_LOAD"
      ? states[timingUrlKey(message.site, message.path)] || null
      : null;
    await storageSet({ [TIMING_SESSION_KEY]: states });
    return message.type === "AIH_TIMING_SESSION_LOAD" ? { state } : {};
  };
  const task = timingSessionQueue.then(operation, operation);
  timingSessionQueue = task.catch(() => {});
  return task;
}

async function deliverConfiguredNotification(event, { ignoreMinimumDuration = false, traceId = "" } = {}) {
  const settings = await storageGet("aiInputHistorySettings") || {};
  const config = settings.completionNotification || {};
  const provider = config.provider || "browser";
  const parsedMinimum = Number.parseInt(config.minDurationSeconds, 10);
  const minDurationSeconds = Number.isFinite(parsedMinimum) ? Math.min(3600, Math.max(0, parsedMinimum)) : 20;
  await appendNotificationDebug({
    traceId, stage: "config-resolved", provider, enabled: config.enabled === true,
    minDurationSeconds, durationMs: Number.isFinite(event?.durationMs) ? event.durationMs : null
  });
  if (config.enabled !== true) return { skipped: true, reason: "disabled", provider };
  if (!ignoreMinimumDuration && Number.isFinite(event?.durationMs) && event.durationMs < minDurationSeconds * 1000) {
    return { skipped: true, reason: "below-min-duration", minDurationSeconds, provider };
  }
  const model = globalThis.AIInputHistory?.notificationModel;
  if (!model) throw new Error("通知模块未加载");
  const delivery = model.buildDelivery(config, event || {}, settings.language);
  if (delivery.kind === "browser") {
    await appendNotificationDebug({ traceId, stage: "browser-create", provider, deliveryKind: "browser" });
    if (!chrome.notifications?.create) throw new Error("请先授权浏览器通知权限");
    await new Promise((resolve, reject) => chrome.notifications.create(`aih-${Date.now()}`, {
      type: "basic", iconUrl: "assets/icons/icon-128.png", title: delivery.title, message: delivery.message
    }, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()));
    return { provider: "browser", deliveryKind: "browser" };
  }
  await appendNotificationDebug({
    traceId, stage: "http-send", provider, deliveryKind: "http", endpointHost: safeEndpointRef(delivery.url)
  });
  const response = await fetch(delivery.url, {
    method: delivery.method,
    headers: delivery.headers,
    body: delivery.body,
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer"
  });
  const responseText = await response.text().catch(() => "");
  await appendNotificationDebug({
    traceId, stage: "http-result", provider, deliveryKind: "http",
    endpointHost: safeEndpointRef(delivery.url), httpStatus: response.status
  });
  if (!response.ok) {
    const detail = responseText.slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`通知请求失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
  }
  model.validateResponse?.(config.provider, responseText);
  return { provider, deliveryKind: "http", httpStatus: response.status };
}
