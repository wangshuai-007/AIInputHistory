"use strict";

if (typeof importScripts === "function") importScripts("src/completion-notification.js");

const LOCK_TIMEOUT_MS = 15_000;
const waiters = [];
let ownerToken = "";
let ownerTimer = null;

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

  if (message?.type === "AIH_REQUEST_COMPLETED" || message?.type === "AIH_NOTIFICATION_TEST") {
    const event = message.type === "AIH_NOTIFICATION_TEST" ? {
      promptText: "这是一条 ChatGPT 回复完成测试通知",
      durationMs: 3200, completedAt: Date.now(), pageUrl: "https://chatgpt.com/"
    } : message.event;
    deliverConfiguredNotification(event, message.type === "AIH_NOTIFICATION_TEST")
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
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

async function deliverConfiguredNotification(event, force = false) {
  const settings = await storageGet("aiInputHistorySettings") || {};
  const config = settings.completionNotification || {};
  if (!force && config.enabled !== true) return { skipped: true };
  const model = globalThis.AIInputHistory?.notificationModel;
  if (!model) throw new Error("通知模块未加载");
  const delivery = model.buildDelivery(config, event || {}, settings.language);
  if (delivery.kind === "browser") {
    if (!chrome.notifications?.create) throw new Error("请先授权浏览器通知权限");
    await new Promise((resolve, reject) => chrome.notifications.create(`aih-${Date.now()}`, {
      type: "basic", iconUrl: "assets/icons/icon-128.png", title: delivery.title, message: delivery.message
    }, () => chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve()));
    return { provider: "browser" };
  }
  const response = await fetch(delivery.url, {
    method: delivery.method,
    headers: delivery.headers,
    body: delivery.body,
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer"
  });
  const responseText = await response.text().catch(() => "");
  if (!response.ok) {
    const detail = responseText.slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`通知请求失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
  }
  model.validateResponse?.(config.provider, responseText);
  return { provider: config.provider || "browser" };
}
