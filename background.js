"use strict";

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
