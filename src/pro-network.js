(function initializeProNetwork(global) {
  "use strict";

  // This observer never exports or persists a request body. Only a small
  // allowlist of model/mode enums is returned to the background diagnostic.
  const FILTER = {
    urls: [
      "https://chatgpt.com/backend-api/f/conversation*",
      "https://chatgpt.com/backend-api/conversation*",
      "https://chat.openai.com/backend-api/f/conversation*",
      "https://chat.openai.com/backend-api/conversation*"
    ],
    types: ["xmlhttprequest", "other"]
  };
  const MAX_JSON_BYTES = 2 * 1024 * 1024;
  const KNOWN_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

  function isConversationPost(details) {
    if (details?.method !== "POST" || !Number.isInteger(details.tabId) || details.tabId < 0)
      return false;
    try {
      const url = new URL(details.url);
      if (url.protocol !== "https:" || !KNOWN_HOSTS.has(url.hostname)
        || !/^\/backend-api\/(?:f\/)?conversation\/?$/.test(url.pathname)) return false;
      if (details.initiator && details.initiator !== "null") {
        const issuer = new URL(details.initiator);
        if (issuer.protocol !== "https:" || !KNOWN_HOSTS.has(issuer.hostname)) return false;
      }
      return true;
    } catch { return false; }
  }

  function safeEnum(value) {
    if (typeof value !== "string") return null;
    const lower = value.trim().toLowerCase();
    return lower.length <= 48 && /^[a-z][a-z0-9._-]*$/.test(lower)
      && !/(?:token|bearer|session|secret|password|apikey)/.test(lower)
      ? lower : null;
  }

  function readPayload(requestBody) {
    if (!requestBody) return { error: "body-unavailable" };
    if (requestBody.error) return { error: "body-unreadable" };
    if (requestBody.formData) {
      // Form submissions are not ChatGPT's JSON conversation wire format.
      return { error: "non-json-form" };
    }
    const items = requestBody.raw;
    if (!Array.isArray(items) || !items.length) return { error: "body-unavailable" };
    let total = 0;
    const chunks = [];
    for (const item of items) {
      if (!(item?.bytes instanceof ArrayBuffer)) return { error: "unsupported-body" };
      const bytes = new Uint8Array(item.bytes);
      total += bytes.byteLength;
      if (total > MAX_JSON_BYTES) return { error: "body-too-large" };
      chunks.push(bytes);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    try {
      const object = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
      return object && typeof object === "object" && !Array.isArray(object)
        ? { body: object } : { error: "non-object-body" };
    } catch { return { error: "invalid-json" }; }
  }

  function proModelId(model) {
    if (!model) return null;
    if (model === "pro") return "pro";
    if (/(?:^|[-_.])pro(?:$|[-_.])/.test(model)) {
      if (/^gpt[-_.]?5(?:[-_.]|[.])6[-_.]?pro(?:$|[-_.])/.test(model)) return "gpt-5.6-pro";
      if (/^gpt[-_.]?6[-_.]?pro(?:$|[-_.])/.test(model)) return "gpt-6-pro";
      return "pro";
    }
    return null;
  }

  function classifyPayload(requestBody) {
    const decoded = readPayload(requestBody);
    if (!decoded.body) return {
      proModelId: null, reason: decoded.error, requestModel: null, requestMode: null,
      action: null, modelField: null, modeField: null
    };
    const body = decoded.body;
    // Never inspect the user prompt, messages[].content, headers, attachments,
    // tokens or full JSON in diagnostics. Message author is used only to
    // distinguish an actual user submission from secondary metadata requests.
    const action = safeEnum(body.action);
    const sent = action === "next"
      && Array.isArray(body.messages)
      && body.messages.some((message) => message?.author?.role === "user");
    const modelField = typeof body.model === "string" ? "model"
      : typeof body.model_slug === "string" ? "model_slug" : null;
    const requestModel = safeEnum(modelField && body[modelField]);
    const possibleModes = [
      ["mode", body.mode],
      ["model_mode", body.model_mode],
      ["inference_mode", body.inference_mode],
      ["reasoning.mode", body.reasoning?.mode]
    ];
    const modeItem = possibleModes.find(([, value]) => typeof value === "string") || null;
    const modeField = modeItem?.[0] || null;
    const requestMode = safeEnum(modeItem?.[1]);
    const explicitPro = proModelId(requestModel);
    const modelId = sent && requestMode !== "standard"
      ? (explicitPro || (requestMode === "pro" ? "pro" : null)) : null;
    const reason = !sent ? "not-user-next-action"
      : !modelField && !modeField ? "model-fields-missing"
      : requestModel === null && requestMode === null ? "model-enum-unrecognized"
      : requestMode === "standard" && explicitPro ? "conflicting-model-mode"
      : modelId ? "explicit-pro-request" : "non-pro-or-auto-request";
    return { proModelId: modelId, reason, requestModel, requestMode,
      action, modelField, modeField };
  }

  function createObserver({ webRequest, onAccepted, onDiagnostic,
    loadEnabled, loadPending, savePending } = {}) {
    if (!webRequest?.onBeforeRequest?.addListener
      || !webRequest?.onResponseStarted?.addListener) return null;
    let enabled = false;
    let initialized = false;
    let settingsRevision = 0;
    let epoch = 0;
    const pending = new Map();
    const emit = (stage, details = {}) => {
      try {
        Promise.resolve(onDiagnostic?.({ stage, source: "network",
          requestModel: details.requestModel || null,
          requestMode: details.requestMode || null,
          requestEndpoint: details.requestEndpoint || null,
          modelField: details.modelField || null, modeField: details.modeField || null,
          reason: details.reason, status: details.status || null,
          action: details.action || null, model: details.proModelId || null,
          sourceTabId: details.tabId
        })).catch(() => {});
      } catch {}
    };
    const persist = async () => {
      try { await savePending?.([...pending.values()]); }
      catch { emit("pro-network-cache-error", { reason: "session-storage-unavailable" }); }
    };
    const restore = (value) => {
      for (const item of (Array.isArray(value) ? value : []).slice(-150)) {
        if (!item || typeof item.requestId !== "string" || item.requestId.length > 128
          || !KNOWN_HOSTS.has(item.site) || !Number.isInteger(item.tabId) || item.tabId < 0
          || !Number.isFinite(item.startedAt) || Date.now() - item.startedAt > 3_600_000
          || item.startedAt > Date.now() + 60_000
          || !/^\/backend-api\/(?:f\/)?conversation\/?$/.test(item.requestEndpoint || "")) continue;
        // Reconstruct an allowlisted record, never trust arbitrary cache fields.
        pending.set(item.requestId, {
          requestId: item.requestId, site: item.site, tabId: item.tabId,
          startedAt: item.startedAt, requestEndpoint: item.requestEndpoint,
          proModelId: ["gpt-6-pro", "gpt-5.6-pro", "pro"].includes(item.proModelId) ? item.proModelId : null,
          requestModel: safeEnum(item.requestModel), requestMode: safeEnum(item.requestMode),
          action: safeEnum(item.action), reason: safeEnum(item.reason),
          modelField: ["model", "model_slug"].includes(item.modelField) ? item.modelField : null,
          modeField: ["mode", "model_mode", "inference_mode", "reasoning.mode"].includes(item.modeField)
            ? item.modeField : null
        });
      }
    };
    // Register listeners synchronously below, but process their events only
    // after settings and the worker-restart cache have loaded. Disabled mode
    // never parses a body. Startup event arguments are short-lived in memory.
    let queue = Promise.all([
      Promise.resolve().then(() => loadEnabled?.()).catch(() => false),
      Promise.resolve().then(() => loadPending?.()).catch(() => [])
    ]).then(([initialEnabled, saved]) => {
      if (settingsRevision === 0 && typeof loadEnabled === "function") enabled = initialEnabled === true;
      if (enabled && settingsRevision === 0) restore(saved);
      initialized = true;
      if (!enabled) return persist();
    });
    const enqueue = (operation) => {
      if (initialized && !enabled) return;
      const eventEpoch = epoch;
      const task = queue.then(async () => {
        if (enabled && eventEpoch === epoch) await operation();
      });
      queue = task.catch(() => emit("pro-network-observer-error", { reason: "observer-operation-failed" }));
      return queue;
    };
    const before = (details) => {
      if (!isConversationPost(details)) return;
      return enqueue(async () => {
        const parsed = classifyPayload(details.requestBody);
        const requestId = String(details.requestId);
        const item = {
          ...parsed, tabId: details.tabId, requestId,
          requestEndpoint: new URL(details.url).pathname,
          site: new URL(details.url).hostname,
          startedAt: pending.get(requestId)?.startedAt
            ?? (Number.isFinite(details.timeStamp) ? details.timeStamp : Date.now())
        };
        for (const [id, previous] of pending) {
          if (Date.now() - previous.startedAt > 3_600_000) pending.delete(id);
        }
        if (!pending.has(requestId) && pending.size >= 150) pending.delete(pending.keys().next().value);
        pending.set(requestId, item);
        emit("pro-network-request", item);
        // Only model/mode metadata survives worker suspension, never raw JSON,
        // prompt text, cookies, authorization headers or attachment data.
        await persist();
      });
    };
    const accepted = async (details) => {
      const id = String(details?.requestId);
      const item = pending.get(id);
      if (!item) return;
      const statusCode = Number(details.statusCode);
      const ok = Number.isInteger(statusCode) && statusCode >= 200 && statusCode < 300;
      emit(ok ? "pro-network-accepted" : "pro-network-rejected", {
        ...item, status: "http-" + (statusCode || "unknown"),
        reason: ok ? item.reason : "http-rejected"
      });
      if (ok && item.proModelId) {
        try {
          await onAccepted?.({
            site: item.site, proModelId: item.proModelId,
            // Chrome request IDs can be reused in a later browser session.
            requestId: "network:" + item.requestId + ":" + item.startedAt,
            tabId: item.tabId, startedAt: item.startedAt,
            requestModel: item.requestModel, requestMode: item.requestMode
          });
        } catch {
          emit("pro-network-count-error", { ...item, reason: "count-storage-failed" });
          return; // Keep metadata so onCompleted can retry a failed write.
        }
      }
      pending.delete(id);
      await persist();
    };
    const failed = (details) => enqueue(async () => {
      const id = String(details?.requestId);
      const item = pending.get(id);
      if (item) emit("pro-network-rejected", {
        ...item, status: "network-error", reason: "network-error"
      });
      pending.delete(id);
      await persist();
    });
    webRequest.onBeforeRequest.addListener(before, FILTER, ["requestBody"]);
    webRequest.onResponseStarted.addListener((details) => enqueue(() => accepted(details)), FILTER);
    webRequest.onCompleted?.addListener((details) => enqueue(() => accepted(details)), FILTER);
    webRequest.onErrorOccurred?.addListener(failed, FILTER);
    return {
      setEnabled(value) {
        settingsRevision++;
        const next = value === true;
        if (enabled !== next) epoch++;
        enabled = next;
        if (!enabled) {
          pending.clear();
          queue = queue.then(persist, persist);
        }
      },
      isEnabled() { return enabled; },
      pendingSize() { return pending.size; },
      flush() { return queue; }
    };
  }

  global.AIHProNetwork = Object.freeze({
    FILTER, isConversationPost, safeEnum, classifyPayload, createObserver
  });
})(globalThis);
