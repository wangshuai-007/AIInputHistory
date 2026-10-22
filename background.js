"use strict";

if (typeof importScripts === "function") {
  importScripts("src/completion-notification.js", "src/pro-network.js");
}

const LOCK_TIMEOUT_MS = 15_000;
const TIMING_SESSION_KEY = "aiInputHistoryActiveTimingByUrl";
const TIMING_FINALIZED_KEY = "aiInputHistoryFinalizedTimingIds";
const PRO_USAGE_KEY = "aiInputHistoryProUsage";
const PRO_QUOTA_KEY = "aiInputHistoryProQuotaStatus";
const PRO_MODELS = new Set(["gpt-6-pro", "gpt-5.6-pro", "pro"]);
const TIMING_MAX_AGE_MS = 30 * 60 * 1000;
const TIMING_PAUSED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TIMING_FINALIZED_MAX_AGE_MS = 60 * 60 * 1000;
const NOTIFICATION_DEBUG_KEY = "aiInputHistoryNotificationDebugLog";
const NOTIFICATION_DEBUG_LIMIT = 500;
const waiters = [];
let ownerToken = "";
let ownerTimer = null;
let timingSessionQueue = Promise.resolve();
let notificationDebugQueue = Promise.resolve();

// Network-observed Pro counting. This is read-only: no request modification,
// no header/cookie access, no prompt/body persistence and no external upload.
// Chrome requires "webRequest" plus host permissions for ChatGPT's origin.
const proNetworkObserver = globalThis.AIHProNetwork?.createObserver({
  webRequest: chrome.webRequest,
  loadEnabled: () => storageGet("aiInputHistorySettings").then((settings) => settings?.trackProUsage === true),
  loadPending: () => chrome.storage.session
    ? storageGet("aiInputHistoryProNetworkPending", chrome.storage.session) : [],
  savePending: (items) => chrome.storage.session
    ? storageSet({ aiInputHistoryProNetworkPending: items }, chrome.storage.session) : undefined,
  onDiagnostic: (entry) => appendNotificationDebug(entry),
  onAccepted: (request) => {
    const operation = async () => {
      if ((await storageGet("aiInputHistorySettings"))?.trackProUsage !== true) return;
      const updated = await prepareProUsageCount({
        site: request.site, proModelId: request.proModelId,
        requestId: request.requestId, tabId: request.tabId,
        startedAt: request.startedAt, countSource: "network",
        proUsageEligible: true
      });
      if (updated) await storageSet({ [PRO_USAGE_KEY]: updated.stats });
      const counted = updated?.counted === true;
      await appendNotificationDebug({
        stage: counted ? "pro-network-counted" : "pro-network-deduplicated",
        source: "network", status: counted ? "recorded" : "duplicate",
        reason: counted ? "http-accepted-explicit-pro" : "already-counted-or-reset",
        model: request.proModelId, requestModel: request.requestModel,
        requestMode: request.requestMode, sourceTabId: request.tabId
      });
    };
    const task = timingSessionQueue.then(operation, operation);
    timingSessionQueue = task.catch(() => {});
    return task;
  }
});
if (proNetworkObserver) {
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.aiInputHistorySettings) {
      proNetworkObserver.setEnabled(changes.aiInputHistorySettings.newValue?.trackProUsage === true);
    }
  });
}

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

  if (["AIH_TIMING_SESSION_SAVE", "AIH_TIMING_SESSION_LOAD", "AIH_TIMING_SESSION_CLEAR", "AIH_TIMING_SESSION_FINALIZE", "AIH_TIMING_SESSION_OBSERVE"].includes(message?.type)) {
    handleTimingSessionMessage(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "AIH_PRO_USAGE_RECORD") {
    // Confirmed send path: deliberately independent from the timing lifecycle.
    // Serialize against timer SAVE and reset, sharing the request ID ledger.
    const operation = async () => {
      const usage = message.usage || {};
      const currentSite = (() => {
        try { return new URL(sender.tab?.url || sender.url).hostname; }
        catch { return null; }
      })();
      if (currentSite && currentSite !== usage.site) {
        return { ok: true, counted: false, reason: "sender-host-mismatch" };
      }
      const settings = await storageGet("aiInputHistorySettings");
      if (settings?.trackProUsage !== true) {
        return { ok: true, counted: false, reason: "counter-disabled" };
      }
      const updated = await prepareProUsageCount({
        ...usage, proUsageEligible: true,
        tabId: sender.tab?.id ?? null, countSource: "dom"
      });
      if (!updated) return {
        ok: true, counted: false, reason: "duplicate-or-invalid-model"
      };
      await storageSet({ [PRO_USAGE_KEY]: updated.stats });
      if (!updated.counted) return {
        ok: true, counted: false, reason: "duplicate-or-invalid-model"
      };
      try {
        await appendNotificationDebug({
          stage: "pro-usage-counted", source: "background",
          reason: "confirmed-send", model: usage.proModelId,
          requestId: usage.requestId, page: usage.site, status: "recorded"
        });
      } catch (error) {
        console.warn("[AI Input History] Pro count log failed", safeError(error));
      }
      return { ok: true, counted: true };
    };
    const task = timingSessionQueue.then(operation, operation);
    timingSessionQueue = task.catch(() => {});
    task.then(sendResponse).catch((error) => sendResponse({
      ok: false, counted: false, reason: "storage-error", error: safeError(error)
    }));
    return true;
  }
  if (message?.type === "AIH_PRO_USAGE_RESET") {
    const operation = async () => {
      const current = await storageGet(PRO_USAGE_KEY);
      const previous = current?.version === 1 && current.models && current.requestIds
        ? current : { version: 1, models: {}, requestIds: {} };
      const resetAt = Date.now();
      const currentMonth = proPeriodKeys(resetAt).month;
      // Reset the *displayed current month* only. Keep totals, day/week
      // history, previous months, and request IDs (refresh deduplication).
      const models = {};
      for (const [id, bucket] of Object.entries(previous.models || {})) {
        models[id] = { ...bucket, months: { ...(bucket.months || {}), [currentMonth]: 0 } };
      }
      await storageSet({
        [PRO_USAGE_KEY]: { ...previous, version: 1, models, monthResetAt: resetAt }
      });
      try {
        await appendNotificationDebug({
          stage: "pro-usage-local-reset", source: "background",
          reason: "current-month-only", status: "local-only"
        });
      } catch (error) {
        console.warn("[AI Input History] Pro reset diagnostic failed", safeError(error));
      }
      return { resetAt };
    };
    const task = timingSessionQueue.then(operation, operation);
    timingSessionQueue = task.catch(() => {});
    task.then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message?.type === "AIH_PRO_QUOTA_OBSERVE") {
    // The content script can only report text already shown by ChatGPT.
    // Never query or proxy an account-only backend endpoint here.
    handleProQuotaObservation(message.signal, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: safeError(error) }));
    return true;
  }

  if (message?.type === "AIH_NOTIFICATION_DEBUG_APPEND") {
    appendNotificationDebug({ ...message.entry, sourceTabId: sender.tab?.id ?? null })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "AIH_NOTIFICATION_DEBUG_GET") {
    notificationDebugQueue.then(() => Promise.all([storageGet(NOTIFICATION_DEBUG_KEY), storageGet(TIMING_SESSION_KEY)]))
      .then(([logs, sessions]) => sendResponse({
        ok: true, logs: Array.isArray(logs) ? logs : [],
        activeSessions: Object.values(sessions || {}).filter((state) => state?.requestId)
          .map(timingDiagnosticSnapshot)
      }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "AIH_NOTIFICATION_DEBUG_CLEAR") {
    const clear = () => storageSet({ [NOTIFICATION_DEBUG_KEY]: [] });
    const task = notificationDebugQueue.then(clear, clear);
    notificationDebugQueue = task.catch(() => {});
    task.then(() => sendResponse({ ok: true }))
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

function storageGet(key, area = chrome.storage.local) {
  return new Promise((resolve, reject) => area.get(key, (result) => {
    const error = chrome.runtime.lastError;
    error ? reject(error) : resolve(result[key]);
  }));
}

function storageSet(value, area = chrome.storage.local) {
  return new Promise((resolve, reject) => area.set(value, () => {
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
    "availableTimeCount", "localTime", "withinAvailableTime", "notificationEligible", "detectionTrigger", "visibility", "page", "sourceTabId", "deliveryKind", "endpointHost", "httpStatus", "skipped", "reason", "error",
    "requestId", "conversationId", "site", "source", "status", "previousStatus", "trigger", "elapsedMs",
    "pausedAt", "pausedDurationMs", "pauseDeltaMs", "pauseVersion", "startedAt", "entryLinked", "confirmedFromSidebar",
    "manualPause", "selectionKind", "model", "remaining", "resetAt", "approximate",
    "lastBusyAt", "targetConversationId", "previousIdKind", "error",
    "modelPickerCandidates", "composerEditorCandidates",
    "requestModel", "requestMode", "requestEndpoint",
    "modelField", "modeField", "action",
    "composerActionCandidates",
    "sidebarLinkCount", "sidebarMarkerCount",
    "accountPlan", "seatField", "seatTypeCode", "seatValueKind",
    "seatMatchedBy", "seatFieldKeys", "seatRecordCount", "seatMapping"];
  const sizes = { requestId: 160, conversationId: 128, site: 100, source: 40,
    reason: 100, trigger: 50, status: 40, stage: 100, error: 240,
    accountPlan: 32, seatField: 48, seatTypeCode: 48, seatValueKind: 20,
    seatMatchedBy: 24, seatFieldKeys: 180, seatMapping: 48 };
  const result = { at: Date.now() };
  allowed.forEach((key) => {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
    else if (typeof value === "string") result[key] = value.slice(0, sizes[key] || 200);
    else if (typeof value === "boolean" || value === null) result[key] = value;
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

/** Write a sidebar-confirmed completion under the same storage lock as input history. */
async function saveSidebarCompletedTiming(state, completedAt) {
  const activePause = Number.isFinite(state.pausedAt) ? Math.max(0, completedAt - state.pausedAt) : 0;
  const durationMs = Math.max(0, completedAt - state.startedAt
    - Math.max(0, Number(state.pausedDurationMs) || 0) - activePause);
  const result = {
    status: "completed", startedAt: state.startedAt, completedAt, durationMs,
    conversationId: timingConversationId(state.path), observedAfterResume: true,
    confirmedFromSidebar: true, detectionTrigger: "sidebar-completion"
  };
  if (!state.entryId) return result;
  const grant = await new Promise((resolve) => {
    waiters.push({ sendResponse: resolve, senderId: "sidebar-timing" });
    grantNext();
  });
  try {
    const data = await storageGet("aiInputHistoryState");
    const entry = data?.entries?.find((item) => item.id === state.entryId && item.kind === "send");
    if (entry && entry.requestTiming?.status !== "completed") {
      entry.requestTiming = result;
      await storageSet({ aiInputHistoryState: data });
    }
  } finally {
    if (grant?.token === ownerToken) releaseOwner();
  }
  return result;
}

function proPeriodKeys(at) {
  const stamp = new Date(at);
  const pad = (part) => String(part).padStart(2, "0");
  const dateKey = (date) => [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-");
  const monday = new Date(stamp.getTime());
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() || 7) + 1);
  return { day: dateKey(stamp), week: dateKey(monday),
    month: [stamp.getFullYear(), pad(stamp.getMonth() + 1)].join("-") };
}

/** Prepare an atomic ledger update for network, confirmed-send or timer reports. */
async function prepareProUsageCount(state) {
  if (state?.proUsageEligible !== true
    || !PRO_MODELS.has(state.proModelId)
    || !/^(chatgpt\.com|chat\.openai\.com)$/i.test(state.site || "")
    || !Number.isFinite(state.startedAt)) return null;
  const id = String(state.requestId || "");
  if (!id || id.length > 180) return null;
  // A delayed timer may still carry an old eligible=true snapshot after the
  // user disables counting. All three entry points must honor the live setting.
  if ((await storageGet("aiInputHistorySettings"))?.trackProUsage !== true) return null;
  const raw = await storageGet(PRO_USAGE_KEY);
  const stats = raw?.version === 1 && raw.models && raw.requestIds
    ? raw : { version: 1, models: {}, requestIds: {} };
  if (Object.prototype.hasOwnProperty.call(stats.requestIds, id)) return null;
  const at = state.startedAt;
  if (Number.isFinite(stats.resetAt) && at <= stats.resetAt) return null;
  if (Number.isFinite(stats.monthResetAt)
    && at <= stats.monthResetAt
    && proPeriodKeys(at).month === proPeriodKeys(stats.monthResetAt).month) return null;

  const source = state.countSource || "timer";
  const record = {
    at, model: state.proModelId, source,
    ...(Number.isInteger(state.tabId) && state.tabId >= 0 ? { tabId: state.tabId } : {})
  };
  // DOM confirmation and timer SAVE share a page requestId. Network reports
  // use a different ID: pair them ONE-TO-ONE, not with every send in a window.
  // Persist the alias even when it does not increment totals, so subsequent
  // timer saves or restored tabs cannot count that same request again.
  if (Number.isInteger(record.tabId) && ["network", "dom", "timer"].includes(source)) {
    const incomingNetwork = source === "network";
    const candidates = Object.entries(stats.requestIds).filter(([, previous]) =>
      previous && !previous.aliasOf && !previous.pairedWith
      && previous.tabId === record.tabId
      && ["network", "dom", "timer"].includes(previous.source)
      && (previous.source === "network") !== incomingNetwork
      && (previous.model === record.model || previous.model === "pro" || record.model === "pro")
      && Number.isFinite(previous.at) && Math.abs(at - previous.at) < 4500);
    candidates.sort((a, b) => Math.abs(at - a[1].at) - Math.abs(at - b[1].at));
    if (candidates.length) {
      const [matchedId, previous] = candidates[0];
      previous.pairedWith = id;
      stats.requestIds[id] = { ...record, aliasOf: matchedId };
      pruneProUsageIds(stats);
      return { stats, counted: false };
    }
  }

  const periods = proPeriodKeys(at);
  const bucket = stats.models[state.proModelId] ||= {
    total: 0, days: {}, weeks: {}, months: {}
  };
  bucket.total += 1;
  bucket.days[periods.day] = (bucket.days[periods.day] || 0) + 1;
  bucket.weeks[periods.week] = (bucket.weeks[periods.week] || 0) + 1;
  bucket.months[periods.month] = (bucket.months[periods.month] || 0) + 1;
  stats.requestIds[id] = record;
  pruneProUsageIds(stats);
  return { stats, counted: true };
}

function pruneProUsageIds(stats) {
  // Bound canonical IDs and aliases together; historical aggregates remain.
  const ids = Object.entries(stats.requestIds);
  if (ids.length > 6000) {
    for (const [expired] of ids.sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0))
      .slice(0, ids.length - 5500)) delete stats.requestIds[expired];
  }
}

function timingDiagnosticSnapshot(state) {
  const at = Date.now();
  const snapshot = timingDebugEvent("timing-snapshot", state, {}, null, at);
  return {
    requestId: snapshot.requestId, conversationId: snapshot.conversationId, site: snapshot.site,
    status: Number.isFinite(state.pausedAt) ? "paused" : "running",
    manualPause: state.manualPause === true, selectionKind: state.selectionKind || null,
    startedAt: snapshot.startedAt, elapsedMs: snapshot.elapsedMs,
    pausedAt: snapshot.pausedAt, pausedDurationMs: snapshot.pausedDurationMs,
    pauseVersion: snapshot.pauseVersion, savedAt: Number(state.savedAt) || null,
    sidebarUnreadCleared: state.sidebarUnreadCleared === true,
    entryLinked: Boolean(state.entryId)
  };
}

function timingDebugEvent(stage, state, details = {}, sourceTabId = null, observedAt = Date.now()) {
  const startedAt = Number(state?.startedAt);
  const pausedAt = Number.isFinite(state?.pausedAt) ? state.pausedAt : null;
  const pausedDurationMs = Math.max(0, Number(state?.pausedDurationMs) || 0);
  return {
    stage, sourceTabId,
    site: state?.site || null,
    requestId: state?.requestId || null,
    conversationId: timingConversationId(state?.path) || null,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    pausedAt, pausedDurationMs,
    pauseVersion: Number(state?.pauseVersion) || 0,
    selectionKind: state?.selectionKind || null,
    elapsedMs: Number.isFinite(startedAt)
      ? Math.max(0, observedAt - startedAt - pausedDurationMs - (pausedAt === null ? 0 : Math.max(0, observedAt - pausedAt))) : null,
    ...details
  };
}

/**
 * Accept only UI-derived, structured Pro-quota signals from ChatGPT frames.
 * Never retain the original UI text, request URLs, headers or account tokens.
 */
async function handleProQuotaObservation(signal, sender = {}) {
  const senderUrl = sender.url || sender.tab?.url || "";
  if (!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:[/?#]|$)/i.test(senderUrl)) {
    return { saved: false, reason: "not-chatgpt-origin" };
  }
  const validModels = new Set(["gpt-6-pro", "gpt-5.6-pro", "pro"]);
  const validStatuses = new Set(["limit-reached", "remaining-shown", "reset-time-shown"]);
  if (!signal || !validModels.has(signal.modelId) || !validStatuses.has(signal.status)
    || signal.source !== "chatgpt-visible-ui") return { saved: false, reason: "invalid-signal" };
  const now = Date.now();
  const resetAt = Number.isFinite(signal.resetAt)
    && signal.resetAt > now && signal.resetAt < now + 366 * 24 * 60 * 60 * 1000
    ? Math.trunc(signal.resetAt) : null;
  const remaining = Number.isSafeInteger(signal.remaining) && signal.remaining >= 0
    && signal.remaining <= 10000 ? signal.remaining : null;
  if (signal.status === "remaining-shown" && remaining === null) {
    return { saved: false, reason: "missing-explicit-remaining" };
  }
  if (signal.status === "reset-time-shown" && resetAt === null) {
    return { saved: false, reason: "missing-explicit-reset-time" };
  }
  const snapshot = {
    modelId: signal.modelId, status: signal.status, source: "chatgpt-visible-ui",
    remaining: signal.status === "remaining-shown" ? remaining : null,
    resetAt, approximate: resetAt !== null && signal.approximate === true,
    observedAt: now
  };
  const operation = async () => {
    const previous = await storageGet(PRO_QUOTA_KEY) || {};
    const fresh = Object.fromEntries(Object.entries(previous).filter(([, value]) =>
      value?.source === "chatgpt-visible-ui"
      && Number.isFinite(value.observedAt) && now - value.observedAt < 60 * 60 * 1000
      && (!Number.isFinite(value.resetAt) || value.resetAt > now)));
    const old = fresh[snapshot.modelId];
    if (old && ["status", "remaining", "resetAt", "approximate"]
      .every((key) => old[key] === snapshot[key]) && now - old.observedAt < 60_000) {
      return { saved: false, reason: "same-signal" };
    }
    fresh[snapshot.modelId] = snapshot;
    await storageSet({ [PRO_QUOTA_KEY]: fresh });
    try {
      await appendNotificationDebug({
        stage: "pro-quota-ui-observed", source: "chatgpt-visible-ui",
        model: snapshot.modelId, status: snapshot.status,
        remaining: snapshot.remaining, resetAt: snapshot.resetAt,
        approximate: snapshot.approximate, sourceTabId: sender.tab?.id ?? null
      });
    } catch (error) {
      console.warn("[AI Input History] Pro quota diagnostic failed", safeError(error));
    }
    return { saved: true };
  };
  const task = timingSessionQueue.then(operation, operation);
  timingSessionQueue = task.catch(() => {});
  return task;
}

async function handleTimingSessionMessage(message, sender = {}) {
  const operation = async () => {
    const now = Date.now();
    const tabId = sender.tab?.id ?? 0;
    const timingLogs = [];
    const trace = (stage, state, details = {}) =>
      timingLogs.push(timingDebugEvent(stage, state, details, tabId, now));
    const stored = await storageGet(TIMING_SESSION_KEY) || {};
    const oldFinalized = await storageGet(TIMING_FINALIZED_KEY) || {};
    const finalized = Object.fromEntries(Object.entries(oldFinalized)
      .filter(([, at]) => Number.isFinite(at) && now - at < TIMING_FINALIZED_MAX_AGE_MS)
      .slice(-200));
    const states = {};
    // Upgrade existing URL-keyed records in place; different GPT layouts share the same conversation ID.
    for (const state of Object.values(stored)) {
      if (!state?.requestId || !Number.isFinite(state.startedAt)
        || typeof state.site !== "string" || !state.site.trim()
        || typeof state.path !== "string" || !state.path.startsWith("/")) continue;
      if (finalized[state.requestId]) continue;
      // A genuinely observed long generation must survive LOAD/FINALIZE.
      // savedAt is not evidence: repeated stale saves must not extend retention.
      const retentionAt = Number.isFinite(state.pausedAt) ? state.startedAt
        : Math.max(state.startedAt, Number.isFinite(state.lastBusyAt)
          ? Math.min(now, state.lastBusyAt) : state.startedAt);
      if (now - retentionAt >= (Number.isFinite(state.pausedAt) ? TIMING_PAUSED_MAX_AGE_MS : TIMING_MAX_AGE_MS)) {
        trace("timing-expired", state, { source: "background", reason: "session-max-age" });
        continue;
      }
      const key = timingSessionKey(state.site, state.path, state.tabId ?? 0);
      if (!states[key] || states[key].startedAt <= state.startedAt) states[key] = state;
    }

    let response = {};
    let proUsageUpdate = null;
    const changed = message.type !== "AIH_TIMING_SESSION_LOAD"
      || JSON.stringify(stored) !== JSON.stringify(states);
    let finalizedChanged = false;

    if (message.type === "AIH_TIMING_SESSION_SAVE") {
      const state = message.state || {};
      if (!state.requestId) throw new Error("请求计时会话缺少 requestId");
      if (finalized[state.requestId]) {
        response = { saved: false, reason: "already-finalized" };
        trace("timing-save-rejected", state, { source: "background", reason: "already-finalized" });
      } else {
        const key = timingSessionKey(state.site, state.path, tabId);
        const previous = states[key];
        const sameRequest = Object.entries(states).find(([, value]) => value?.requestId === state.requestId);
        const baseline = previous?.requestId === state.requestId ? previous : sameRequest?.[1];
        if (previous?.requestId !== state.requestId && previous?.startedAt > state.startedAt) {
          response = { saved: false, reason: "newer-request-active" };
          trace("timing-save-rejected", state, { source: "background", reason: "newer-request-active" });
        } else {
          if (previous?.requestId && previous.requestId !== state.requestId) {
            finalized[previous.requestId] = now;
            finalizedChanged = true;
            trace("timing-superseded", previous, { source: "background", reason: "new-request-same-conversation" });
          }
          for (const [existingKey, value] of Object.entries(states)) {
            if (value?.requestId === state.requestId) delete states[existingKey];
          }
          const pauseVersion = Number(previous?.pauseVersion) || 0;
          const olderPauseState = previous?.requestId === state.requestId
            && pauseVersion > (Number(state.pauseVersion) || 0);
          states[key] = {
            ...state,
            pausedAt: olderPauseState ? previous.pausedAt : (Number.isFinite(state.pausedAt) ? state.pausedAt : null),
            pausedDurationMs: olderPauseState ? previous.pausedDurationMs : (Number(state.pausedDurationMs) || 0),
            pauseVersion: olderPauseState ? pauseVersion : (Number(state.pauseVersion) || 0),
            sidebarUnreadCleared: previous?.requestId === state.requestId && previous.sidebarUnreadCleared === true
              ? true : state.sidebarUnreadCleared === true,
            manualPause: olderPauseState ? previous.manualPause === true : state.manualPause === true,
            lastBusyAt: Math.max(0, Number(baseline?.lastBusyAt) || 0, Number(state.lastBusyAt) || 0) || null,
            tabId: timingConversationId(state.path) ? null : tabId, savedAt: now
          };
          response = { saved: true };
          // Exactly-once Pro usage is based on the timer requestId, never on
          // restoring, re-saving or finishing that timer.
          proUsageUpdate = await prepareProUsageCount({
            ...state, tabId, countSource: "timer"
          });
          const saved = states[key];
          if (proUsageUpdate?.counted) {
            trace("pro-usage-counted", saved, {
              source: "background", reason: "new-pro-timer-start",
              model: state.proModelId, entryLinked: Boolean(state.entryId)
            });
          }
          if (!baseline) trace("timing-started", saved, { source: "content", entryLinked: Boolean(saved.entryId) });
          else if (sameRequest?.[0] !== key && sameRequest) {
            trace("timing-conversation-bound", saved, { source: "content", reason: "conversation-id-resolved" });
          }
          if (baseline && Number(saved.pauseVersion) > (Number(baseline.pauseVersion) || 0)
            && Number.isFinite(saved.pausedAt) !== Number.isFinite(baseline.pausedAt)) {
            const isPaused = Number.isFinite(saved.pausedAt);
            trace(isPaused ? "timing-paused" : "timing-resumed", saved, {
              source: "content", reason: state.lastTransitionReason || (isPaused ? "page-selection" : "page-resumed"),
              pauseDeltaMs: isPaused ? 0 : Math.max(0, saved.pausedDurationMs - (baseline.pausedDurationMs || 0))
            });
          }
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
        for (const [, state] of matched) trace(message.type === "AIH_TIMING_SESSION_FINALIZE"
          ? "timing-finished" : "timing-cleared", state, {
            source: "content", status: message.status || "cleared", reason: message.status || "explicit-clear"
          });
      } else if (message.type === "AIH_TIMING_SESSION_FINALIZE") {
        trace("timing-finalize-skipped", { requestId, site: message.site, path: message.path }, {
          source: "content", status: message.status || null, reason: "already-finalized-or-missing"
        });
      }
      response = message.type === "AIH_TIMING_SESSION_FINALIZE"
        ? { claimed: matched.length > 0 } : {};
    }

    if (message.type === "AIH_TIMING_SESSION_OBSERVE") {
      const key = timingSessionKey(message.site, message.path, tabId);
      const state = states[key];
      const status = message.status;
      if (!state || state.requestId !== message.requestId) {
        response = { applied: false, reason: "request-not-active" };
        if (status === "completed") trace("timing-observation-rejected", {
          site: message.site, path: message.path, requestId: message.requestId
        }, { source: "sidebar", status, reason: "request-not-active" });
      } else if (status === "manual-paused") {
        if (!Number.isFinite(state.pausedAt)) state.pausedAt = now;
        state.manualPause = true;
        state.pauseVersion = Math.max(now, (state.pauseVersion || 0) + 1);
        state.savedAt = now;
        response = { applied: true, paused: true, manualPause: true };
        trace("timing-paused", state, { source: "sidebar", reason: "manual-right-click", status });
      } else if (status === "manual-running") {
        const pauseDeltaMs = Number.isFinite(state.pausedAt) ? Math.max(0, now - state.pausedAt) : 0;
        state.pausedDurationMs = (state.pausedDurationMs || 0) + pauseDeltaMs;
        state.pausedAt = null;
        state.manualPause = false;
        state.pauseVersion = Math.max(now, (state.pauseVersion || 0) + 1);
        state.savedAt = now;
        response = { applied: true, paused: false, manualPause: false };
        trace("timing-resumed", state, { source: "sidebar", reason: "manual-right-click", status, pauseDeltaMs });
      } else if (status === "paused" && !Number.isFinite(state.pausedAt)) {
        state.pausedAt = now;
        state.pauseVersion = Math.max(now, (state.pauseVersion || 0) + 1);
        state.savedAt = now;
        response = { applied: true, paused: true };
        trace("timing-paused", state, { source: "sidebar", reason: "sidebar-awaiting-user", status });
      } else if (status === "running" && Number.isFinite(state.pausedAt) && state.manualPause !== true) {
        const pauseDeltaMs = Math.max(0, now - state.pausedAt);
        state.pausedDurationMs = (state.pausedDurationMs || 0) + pauseDeltaMs;
        state.pausedAt = null;
        state.pauseVersion = Math.max(now, (state.pauseVersion || 0) + 1);
        state.savedAt = now;
        response = { applied: true, paused: false };
        trace("timing-resumed", state, { source: "sidebar", reason: "sidebar-generation-resumed", status, pauseDeltaMs });
      } else if (status === "unread-cleared" && state.sidebarUnreadCleared === false) {
        state.sidebarUnreadCleared = true;
        state.savedAt = now;
        response = { applied: true };
        trace("timing-sidebar-unread-baselined", state, { source: "sidebar", reason: "previous-unread-cleared" });
      } else if (status === "completed" && state.sidebarUnreadCleared === true
        && Number.isFinite(state.lastBusyAt) && now - state.lastBusyAt < 12_000) {
        response = { applied: false, reason: "generation-still-observed" };
        if (!Number.isFinite(state.sidebarCompletionDeferredAt)
          || now - state.sidebarCompletionDeferredAt >= 30_000) {
          state.sidebarCompletionDeferredAt = now;
          trace("timing-sidebar-completion-deferred", state, {
            source: "background", status, reason: "recent-generation-heartbeat"
          });
        }
      } else if (status === "completed" && state.sidebarUnreadCleared === true) {
        const result = await saveSidebarCompletedTiming(state, now);
        delete states[key];
        finalized[state.requestId] = now;
        finalizedChanged = true;
        response = { applied: true, claimed: true, durationMs: result.durationMs };
        trace("timing-finished", state, {
          source: "sidebar", status: "completed", reason: "sidebar-completion-observed",
          durationMs: result.durationMs, confirmedFromSidebar: true
        });
        // The sidebar signal confirms completion, but cannot reveal the earlier
        // server completion timestamp. Report the observation as an upper bound.
        const event = { ...state.completionContext, ...result, notificationEligible: true };
        deliverConfiguredNotification(event).catch((error) =>
          console.warn("[AI Input History] 侧边栏完成通知失败", safeError(error)));
      } else response = { applied: false, reason: "unchanged-or-unverified" };
    }

    if (message.type === "AIH_TIMING_SESSION_LOAD") {
      const key = timingSessionKey(message.site, message.path, tabId);
      response = { state: states[key] || null };
    }

    if (changed) {
      await storageSet({
        [TIMING_SESSION_KEY]: states,
        ...(proUsageUpdate ? { [PRO_USAGE_KEY]: proUsageUpdate.stats } : {})
      });
    }
    if (finalizedChanged || JSON.stringify(oldFinalized) !== JSON.stringify(finalized)) {
      await storageSet({ [TIMING_FINALIZED_KEY]: finalized });
    }
    // Diagnostics must never prevent the timer state itself from being saved.
    for (const entry of timingLogs) {
      try { await appendNotificationDebug(entry); }
      catch (error) { console.warn("[AI Input History] 计时日志保存失败", safeError(error)); }
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
