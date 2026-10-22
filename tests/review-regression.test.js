"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");

function setup(initial = {}) {
  let now = Date.now();
  let listener;
  const events = {}, storageListeners = [];
  const data = structuredClone({
    aiInputHistorySettings: { trackProUsage: true, completionNotification: { enabled: false } },
    ...initial
  });
  const context = vm.createContext({
    URL, URLSearchParams, ArrayBuffer, Uint8Array, TextDecoder,
    setTimeout, clearTimeout, crypto: { randomUUID },
    console: { info() {}, warn() {}, error() {} },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    },
    chrome: {
      runtime: { lastError: null, onMessage: { addListener(fn) { listener = fn; } } },
      storage: {
        onChanged: { addListener(fn) { storageListeners.push(fn); } },
        local: {
          get(key, callback) { callback({ [key]: structuredClone(data[key]) }); },
          set(values, callback) {
            const changes = Object.fromEntries(Object.entries(values).map(([key, value]) =>
              [key, { oldValue: data[key], newValue: structuredClone(value) }]));
            Object.assign(data, structuredClone(values));
            for (const fn of storageListeners) fn(changes, "local");
            callback?.();
          }
        }
      },
      webRequest: Object.fromEntries(["onBeforeRequest", "onResponseStarted", "onCompleted", "onErrorOccurred"]
        .map((name) => [name, { addListener(fn) { events[name] = fn; } }]))
    }
  });
  const load = (name) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", name), "utf8"), context);
  context.importScripts = (...names) => names.forEach(load);
  load("background.js");
  const settle = async () => {
    await Promise.resolve();
    await vm.runInContext("proNetworkObserver?.flush?.()", context);
    await vm.runInContext("Promise.all([timingSessionQueue, notificationDebugQueue])", context);
  };
  const send = (message, tabId = 7) => new Promise((resolve, reject) => {
    try { listener(message, { tab: { id: tabId, url: "https://chatgpt.com/c/review" },
      url: "https://chatgpt.com/c/review" }, resolve); } catch (error) { reject(error); }
  });
  const network = async (id, at = now, model = "gpt-6-pro") => {
    const bytes = new TextEncoder().encode(JSON.stringify({ action: "next", model,
      messages: [{ author: { role: "user" }, content: { parts: ["private test prompt"] } }] }));
    events.onBeforeRequest({ requestId: id, method: "POST", tabId: 7, timeStamp: at,
      initiator: "https://chatgpt.com", url: "https://chatgpt.com/backend-api/f/conversation",
      requestBody: { raw: [{ bytes: bytes.buffer }] } });
    events.onResponseStarted({ requestId: id, statusCode: 200 });
    events.onCompleted({ requestId: id, statusCode: 200 });
    await settle();
  };
  const usage = (id, at = now, model = "gpt-6-pro") => ({
    site: "chatgpt.com", path: "/c/review", requestId: id, startedAt: at,
    proModelId: model, proUsageEligible: true
  });
  return { data, context, events, send, network, usage, settle,
    now: () => now, advance(ms) { now += ms; },
    total: () => Object.values(data.aiInputHistoryProUsage?.models || {})
      .reduce((sum, bucket) => sum + bucket.total, 0) };
}

for (const order of [
  ["timer", "network", "dom"], ["network", "dom", "timer"],
  ["network", "timer", "dom"], ["dom", "network", "timer"],
  ["timer", "dom", "network"], ["dom", "timer", "network"]
]) test(`review: one Pro send counts once in ${order.join(" -> ")} order`, async () => {
  const h = setup();
  await h.settle();
  const usage = h.usage("same-send");
  for (const source of order) {
    if (source === "network") await h.network("request-1", usage.startedAt + 100);
    else await h.send(source === "timer"
      ? { type: "AIH_TIMING_SESSION_SAVE", state: usage }
      : { type: "AIH_PRO_USAGE_RECORD", usage });
  }
  assert.equal(h.total(), 1);
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: usage }, 99);
  assert.equal(h.total(), 1, "a deduplicated page request stays deduplicated after tab restore");
});

test("review: a paired network event cannot swallow the next quick DOM send", async () => {
  const h = setup();
  await h.settle();
  await h.network("first-network");
  await h.send({ type: "AIH_PRO_USAGE_RECORD", usage: h.usage("first-dom", h.now() + 100) });
  await h.send({ type: "AIH_PRO_USAGE_RECORD", usage: h.usage("second-dom", h.now() + 1000) });
  assert.equal(h.total(), 2);
});

test("review: explicitly different models are not time-window duplicates", async () => {
  const h = setup();
  await h.settle();
  await h.network("gpt6");
  await h.send({ type: "AIH_PRO_USAGE_RECORD", usage: h.usage("gpt56", h.now() + 500, "gpt-5.6-pro") });
  assert.equal(h.total(), 2);
});

test("review: reused Chrome request IDs in a later browser session still count", async () => {
  const h = setup();
  await h.settle();
  await h.network("1");
  h.advance(86_400_000);
  await h.network("1");
  assert.equal(h.total(), 2);
});

test("review: disabled Pro setting also gates delayed timing SAVE reports", async () => {
  const h = setup({ aiInputHistorySettings: { trackProUsage: false } });
  await h.send({ type: "AIH_TIMING_SESSION_SAVE", state: h.usage("disabled") });
  assert.equal(h.total(), 0);
});

test("review: a live request older than 30 minutes can still be finalized", async () => {
  const h = setup();
  const state = { ...h.usage("long-running", h.now() - 31 * 60_000),
    lastBusyAt: h.now() - 1000, proUsageEligible: false };
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_SAVE", state })).saved, true);
  const loaded = await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: state.site, path: state.path });
  assert.equal(loaded.state?.requestId, state.requestId, "recent generation must keep the request alive");
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_FINALIZE", requestId: state.requestId,
    status: "completed" })).claimed, true);
});

test("review: stale unobserved timing still expires", async () => {
  const h = setup({ aiInputHistoryActiveTimingByUrl: {
    stale: { requestId: "stale", site: "chatgpt.com", path: "/c/review",
      startedAt: Date.now() - 61 * 60_000, lastBusyAt: Date.now() - 31 * 60_000 }
  } });
  assert.equal((await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/review" })).state, null);
});

test("review: one malformed timing record does not break valid sessions", async () => {
  const h = setup({ aiInputHistoryActiveTimingByUrl: {
    malformed: { requestId: "bad", startedAt: Date.now(), site: "chatgpt.com", path: null },
    valid: { requestId: "good", startedAt: Date.now(), site: "chatgpt.com", path: "/c/review" }
  } });
  const loaded = await h.send({ type: "AIH_TIMING_SESSION_LOAD", site: "chatgpt.com", path: "/c/review" });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.state?.requestId, "good");
});

test("review: clearing diagnostics is ordered after already submitted appends", async () => {
  const h = setup();
  await Promise.all([
    h.send({ type: "AIH_NOTIFICATION_DEBUG_APPEND", entry: { stage: "before-clear" } }),
    h.send({ type: "AIH_NOTIFICATION_DEBUG_CLEAR" })
  ]);
  await h.settle();
  assert.equal((await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).logs.length, 0);
  await h.send({ type: "AIH_NOTIFICATION_DEBUG_APPEND", entry: { stage: "after-clear" } });
  assert.equal((await h.send({ type: "AIH_NOTIFICATION_DEBUG_GET" })).logs.at(-1).stage, "after-clear");
});

test("review: the first network event during worker startup is not lost", async () => {
  const h = setup();
  // Do not await settings initialization before the event that wakes the worker.
  await h.network("startup-request");
  assert.equal(h.total(), 1);
});
