"use strict";

if (typeof importScripts === "function") importScripts("src/completion-notification.js");

const LOCK_TIMEOUT_MS = 15_000;
const TIMING_SESSION_KEY = "aiInputHistoryActiveTimingByUrl";
const TIMING_FINALIZED_KEY = "aiInputHistoryFinalizedTimingIds";
const TIMING_MAX_AGE_MS = 30 * 60 * 1000;
const TIMING_FINALIZED_MAX_AGE_MS = 60 * 60 * 1000;
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

  if (["AIH_TIMING_SESSION_SAVE", "AIH_TIMING_SESSION_LOAD", "AIH_TIMING_SESSION_CLEAR", "AIH_TIMING_SESSION_FINALIZE"].includes(message?.type)) {
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
      .then(() => deliverConfiguredNotification(event, { ignoreMinimumDuration: isTest, ignoreAvailableTime: isTest, traceId }))
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
    "availableTimeCount", "localTime", "withinAvailableTime", "notificationEligible", "detectionTrigger", "visibility", "page", "sourceTabId", "deliveryKind", "endpointHost", "httpStatus", "skipped", "reason", "error"];
  const result = { at: Date.now() };
  allowed.forEach((key) => {
    const value = entry[key];
    if (["string", "number", "boolean"].includes(typeof value) || value === null) result[key] = value;
  });
  return result;
}

function appendNotificationDebug(entry = {}) {
  const record = sanitizeNotificationDebugEntry(entry);
  console.info("[AI Input History][诊断日志]", record);
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
    availableTimeCount: Number.isFinite(result.availableTimeCount) ? result.availableTimeCount : null,
    localTime: result.localTime || null, withinAvailableTime: typeof result.withinAvailableTime === "boolean" ? result.withinAvailableTime : null,
    httpStatus: Number.isFinite(result.httpStatus) ? result.httpStatus : null
  };
}

function timingConversationId(path) {
  const match = String(path || "").match(/(?:^|\/)c\/([^/?#]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); }
  catch { return match[1]; }
}

function timingSessionKey(site, path, tabId = 0) {
  const host = String(site || "").trim().toLowerCase();
  const pathname = String(path || "").trim();
  if (!host || !pathname.startsWith("/")) throw new Error("请求计时会话缺少有效 URL");
  const conversationId = timingConversationId(pathname);
  // New conversations have no server-side ID yet. Keep them isolated per Chrome tab.
  return conversationId ? host + "::conversation:" + conversationId : host + "::pending-tab:" + tabId;
}

async function handleTimingSessionMessage(message, sender = {}) {
  const operation = async () => {
    const now = Date.now();
    const tabId = sender.tab?.id ?? 0;
    const stored = await storageGet(TIMING_SESSION_KEY) || {};
    const oldFinalized = await storageGet(TIMING_FINALIZED_KEY) || {};
    const finalized = Object.fromEntries(Object.entries(oldFinalized)
      .filter(([, at]) => Number.isFinite(at) && now - at < TIMING_FINALIZED_MAX_AGE_MS)
      .slice(-200));
    const states = {};
    // Upgrade existing URL-keyed records in place; different GPT layouts share the same conversation ID.
    for (const state of Object.values(stored)) {
      if (!state?.requestId || !Number.isFinite(state.startedAt)
        || now - state.startedAt >= TIMING_MAX_AGE_MS || finalized[state.requestId]) continue;
      const key = timingSessionKey(state.site, state.path, state.tabId ?? 0);
      if (!states[key] || states[key].startedAt <= state.startedAt) states[key] = state;
    }

    let response = {};
    const changed = message.type !== "AIH_TIMING_SESSION_LOAD"
      || JSON.stringify(stored) !== JSON.stringify(states);
    let finalizedChanged = false;

    if (message.type === "AIH_TIMING_SESSION_SAVE") {
      const state = message.state || {};
      if (!state.requestId) throw new Error("请求计时会话缺少 requestId");
      if (finalized[state.requestId]) response = { saved: false, reason: "already-finalized" };
      else {
        const key = timingSessionKey(state.site, state.path, tabId);
        const previous = states[key];
        if (previous?.requestId !== state.requestId && previous?.startedAt > state.startedAt) {
          response = { saved: false, reason: "newer-request-active" };
        } else {
          if (previous?.requestId && previous.requestId !== state.requestId) {
            finalized[previous.requestId] = now;
            finalizedChanged = true;
          }
          for (const [existingKey, value] of Object.entries(states)) {
            if (value?.requestId === state.requestId) delete states[existingKey];
          }
          states[key] = { ...state, tabId: timingConversationId(state.path) ? null : tabId, savedAt: now };
          response = { saved: true };
        }
      }
    }

    if (message.type === "AIH_TIMING_SESSION_CLEAR" || message.type === "AIH_TIMING_SESSION_FINALIZE") {
      const requestId = String(message.requestId || "");
      const matched = Object.entries(states).filter(([, state]) => state?.requestId === requestId);
      for (const [key] of matched) delete states[key];
      if (requestId && matched.length) {
        finalized[requestId] = now;
        finalizedChanged = true;
      }
      response = message.type === "AIH_TIMING_SESSION_FINALIZE"
        ? { claimed: matched.length > 0 } : {};
    }

    if (message.type === "AIH_TIMING_SESSION_LOAD") {
      const key = timingSessionKey(message.site, message.path, tabId);
      response = { state: states[key] || null };
    }

    if (changed) await storageSet({ [TIMING_SESSION_KEY]: states });
    if (finalizedChanged || JSON.stringify(oldFinalized) !== JSON.stringify(finalized)) {
      await storageSet({ [TIMING_FINALIZED_KEY]: finalized });
    }
    return response;
  };
  const task = timingSessionQueue.then(operation, operation);
  timingSessionQueue = task.catch(() => {});
  return task;
}

function sanitizeNotificationAvailableTimes(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  return source.map((range) => {
    const start = String(range?.start || "").trim();
    const end = String(range?.end || "").trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) return null;
    const key = `${start}-${end}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { start, end };
  }).filter(Boolean).slice(0, 12);
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(":").map(Number);
  return hours * 60 + minutes;
}

function notificationTimeStatus(ranges, date = new Date()) {
  const normalized = sanitizeNotificationAvailableTimes(ranges);
  const localMinute = date.getHours() * 60 + date.getMinutes();
  const localTime = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (!normalized.length) return { withinAvailableTime: true, availableTimeCount: 0, localTime };
  const withinAvailableTime = normalized.some(({ start, end }) => {
    const startMinute = timeToMinutes(start);
    const endMinute = timeToMinutes(end);
    if (startMinute === endMinute) return true;
    if (startMinute < endMinute) return localMinute >= startMinute && localMinute < endMinute;
    return localMinute >= startMinute || localMinute < endMinute;
  });
  return { withinAvailableTime, availableTimeCount: normalized.length, localTime };
}

async function deliverConfiguredNotification(event, { ignoreMinimumDuration = false, ignoreAvailableTime = false, traceId = "" } = {}) {
  const settings = await storageGet("aiInputHistorySettings") || {};
  const config = settings.completionNotification || {};
  const provider = config.provider || "browser";
  const parsedMinimum = Number.parseInt(config.minDurationSeconds, 10);
  const minDurationSeconds = Number.isFinite(parsedMinimum) ? Math.min(3600, Math.max(0, parsedMinimum)) : 20;
  const timeStatus = notificationTimeStatus(config.availableTimes);
  await appendNotificationDebug({
    traceId, stage: "config-resolved", provider, enabled: config.enabled === true,
    minDurationSeconds, durationMs: Number.isFinite(event?.durationMs) ? event.durationMs : null,
    ...timeStatus
  });
  if (config.enabled !== true) return { skipped: true, reason: "disabled", provider };
  if (!ignoreMinimumDuration && Number.isFinite(event?.durationMs) && event.durationMs < minDurationSeconds * 1000) {
    return { skipped: true, reason: "below-min-duration", minDurationSeconds, provider, ...timeStatus };
  }
  if (!ignoreAvailableTime && !timeStatus.withinAvailableTime) {
    return { skipped: true, reason: "outside-available-time", minDurationSeconds, provider, ...timeStatus };
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
    return { provider: "browser", deliveryKind: "browser", ...timeStatus };
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
  return { provider, deliveryKind: "http", httpStatus: response.status, ...timeStatus };
}
