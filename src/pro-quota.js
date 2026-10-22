(function initializeProQuota(namespace) {
  "use strict";

  // This reads visible, first-party UI only. It does not intercept requests or
  // access auth headers/cookies, and deliberately does not estimate an allowance.
  const STORAGE_KEY = "aiInputHistoryProQuotaStatus";
  const MODEL_LABELS = { "gpt-6-pro": "GPT-6 Pro", "gpt-5.6-pro": "GPT-5.6 Sol Pro", pro: "Pro (shared/unspecified)" };
  const CANDIDATES = [
    '[role="alert"]', '[role="status"]', '[role="dialog"]',
    '[role="menuitem"]', '[role="menuitemradio"]', '[role="option"]',
    '[data-testid*="rate-limit"]', '[data-testid*="usage-limit"]',
    '[data-testid*="quota"]', '[data-testid*="limit-modal"]',
    '[data-testid*="model-picker"]', '[data-testid*="model-switcher"]',
    '[data-testid*="tooltip"]', '[data-testid*="toast"]'
  ].join(",");

  function isChatGPT(host) {
    return ["chatgpt.com", "chat.openai.com"].includes(String(host || "").toLowerCase());
  }

  function modelFromText(text) {
    if (/\bgpt[\s-]*5\.6(?:\s+sol)?\s+pro\b/i.test(text)) return "gpt-5.6-pro";
    if (/\bgpt[\s-]*6(?:\.\d+)?\s+pro\b/i.test(text)) return "gpt-6-pro";
    if (/\bpro(?:\s+(?:model|mode|messages?|quota|allowance|limits?))?\b/i.test(text)
      && !/\bpro\s+(?:subscription|plan|account|tier)\b/i.test(text)) return "pro";
    if (/Pro\s*模型|Pro\s*模式|Pro\s*额度|Pro\s*剩余|Pro\s*上限/i.test(text)) return "pro";
    return null;
  }

  function validFuture(value, now) {
    return Number.isFinite(value) && value > now - 60_000
      && value < now + 366 * 24 * 60 * 60 * 1000 ? value : null;
  }

  function parseResetTime(text, now = Date.now()) {
    const value = String(text || "").replace(/\s+/g, " ");
    // ISO 8601 with a timezone is authoritative; local dates otherwise use
    // the user's browser timezone. Do not infer an arbitrary server timezone.
    const iso = value.match(/\b(20\d{2}-\d{1,2}-\d{1,2}T\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2}))\b/i);
    if (iso) {
      const resetAt = validFuture(Date.parse(iso[1]), now);
      if (resetAt) return { resetAt, approximate: false };
    }
    const numeric = value.match(/\b(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})日?\s*(?:at\s*)?(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
    if (numeric) {
      let hours = Number(numeric[4]);
      if (numeric[6]) hours = (hours % 12) + (/pm/i.test(numeric[6]) ? 12 : 0);
      const dt = new Date(Number(numeric[1]), Number(numeric[2]) - 1,
        Number(numeric[3]), hours, Number(numeric[5]));
      if (dt.getFullYear() === Number(numeric[1]) && dt.getMonth() + 1 === Number(numeric[2])
        && dt.getDate() === Number(numeric[3]) && dt.getHours() === hours) {
        const resetAt = validFuture(dt.getTime(), now);
        if (resetAt) return { resetAt, approximate: false };
      }
    }
    const english = value.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+20\d{2}\s*(?:at\s*)?\d{1,2}:\d{2}\s*(?:AM|PM)?\b/i);
    if (english) {
      const resetAt = validFuture(Date.parse(english[0].replace(/\s+at\s+/i, " ")), now);
      if (resetAt) return { resetAt, approximate: false };
    }
    const tomorrow = value.match(/(?:tomorrow|明天|翌日)\s*(?:at|于|在|的)?\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (tomorrow) {
      let hours = Number(tomorrow[1]);
      if (tomorrow[3]) hours = (hours % 12) + (/pm/i.test(tomorrow[3]) ? 12 : 0);
      const dt = new Date(now);
      dt.setDate(dt.getDate() + 1);
      dt.setHours(hours, Number(tomorrow[2]), 0, 0);
      const resetAt = validFuture(dt.getTime(), now);
      if (resetAt) return { resetAt, approximate: true };
    }
    // Relative wording can be rounded by ChatGPT. Mark the resulting
    // timestamp as approximate and never label it a precise official timestamp.
    const hours = value.match(/(?:in|再过|约|还有)\s*(\d{1,3})\s*(?:hours?|hrs?|小时)/i);
    const mins = value.match(/(?:in|再过|约|还有|\d+\s*小时\s*)(\d{1,3})\s*(?:minutes?|mins?|分钟)/i);
    if (hours || mins) {
      const delta = (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
      const resetAt = validFuture(now + delta * 60_000, now);
      if (resetAt) return { resetAt, approximate: true };
    }
    return { resetAt: null, approximate: false };
  }

  function parseMessage(text, now = Date.now()) {
    const value = String(text || "").replace(/\s+/g, " ").trim().slice(0, 900);
    const modelId = modelFromText(value);
    if (!modelId) return null;
    const limitCue = /\b(?:limit|quota|allowance|remaining|reached|resets?|available again)\b|上限|配额|额度|限制|剩余|重置|恢复使用|可再次使用/i;
    if (!limitCue.test(value)) return null;
    const reached = /\b(?:you(?:'ve| have) reached|limit reached|quota exhausted|no (?:messages?|requests?) (?:left|remaining)|out of (?:messages?|uses?)|temporarily unavailable|0 (?:messages?|requests?) (?:left|remaining))\b|已达到.{0,35}上限|达到.{0,35}上限|已用尽|次数用完|额度耗尽|暂时不可用/i.test(value);
    const remainingMatch = value.match(/\b(\d{1,5})\s*(?:messages?|requests?|uses?)?\s*(?:remaining|left)\b|(?:remaining|left)\s*[:：]?\s*(\d{1,5})\b|剩余\s*(\d{1,5})\s*次|还有\s*(\d{1,5})\s*次/i);
    const remainingNumber = remainingMatch && Number(remainingMatch.slice(1).find(Boolean));
    const remaining = Number.isSafeInteger(remainingNumber) && remainingNumber >= 0 && remainingNumber <= 10000
      && remainingMatch ? remainingNumber : null;
    const resetCue = /(?:resets?|available again|try again|重置|恢复使用|再次使用)/i.test(value);
    const reset = resetCue ? parseResetTime(value, now) : { resetAt: null, approximate: false };
    // Limit information without a concrete reached/remaining/reset signal is
    // not account-specific status (e.g. help text about 200 messages/week).
    if (!reached && remaining === null && !reset.resetAt) return null;
    return {
      modelId, status: reached || remaining === 0 ? "limit-reached"
        : remaining !== null ? "remaining-shown" : "reset-time-shown",
      remaining, resetAt: reset.resetAt, approximate: reset.approximate,
      observedAt: now, source: "chatgpt-visible-ui"
    };
  }

  function visible(element) {
    if (element.closest?.("[data-ai-input-history],[data-message-author-role],[data-turn-key],[data-user-message-bubble]")) return false;
    if (element.getAttribute?.("aria-hidden") === "true" || element.closest?.("[hidden],[inert]")) return false;
    return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
  }

  function detect(doc = globalThis.document, now = Date.now()) {
    if (!doc?.querySelectorAll) return [];
    const observed = new Map();
    const nodes = [...doc.querySelectorAll(CANDIDATES)].slice(0, 250);
    for (const node of nodes) {
      if (!visible(node)) continue;
      const raw = [node.getAttribute?.("aria-label"), node.getAttribute?.("title"),
        node.textContent].filter(Boolean).join(" ");
      const signal = parseMessage(raw, now);
      if (!signal) continue;
      const previous = observed.get(signal.modelId);
      const rank = (entry) => (entry.status === "limit-reached" ? 4
        : entry.status === "remaining-shown" ? 3 : 2)
        + (Number.isFinite(entry.resetAt) ? 1 : 0);
      if (!previous || rank(signal) > rank(previous)) observed.set(signal.modelId, signal);
    }
    return [...observed.values()];
  }

  function activeStatus(value, now = Date.now()) {
    if (!value || value.source !== "chatgpt-visible-ui"
      || !["limit-reached", "remaining-shown", "reset-time-shown"].includes(value.status)
      || !Number.isFinite(value.observedAt)) return null;
    const resetExpired = Number.isFinite(value.resetAt) && value.resetAt <= now;
    const maxAge = value.status === "remaining-shown" ? 5 * 60_000 : 60 * 60_000;
    if (resetExpired || now - value.observedAt > maxAge || now < value.observedAt - 60_000) return null;
    return value;
  }

  class Observer {
    constructor({ doc = globalThis.document, host = globalThis.location?.hostname,
      onSignal = () => {}, now = Date.now, timer = (fn, delay) => setTimeout(fn, delay),
      untimer = (id) => clearTimeout(id), MutationObserverClass = globalThis.MutationObserver } = {}) {
      Object.assign(this, { doc, host, onSignal, now, timer, untimer, MutationObserverClass });
      this.lastSent = new Map();
    }

    start() {
      if (this.started || !isChatGPT(this.host)) return;
      this.started = true;
      this.scan();
      if (!this.MutationObserverClass || !this.doc?.documentElement) return;
      this.observer = new this.MutationObserverClass(() => {
        if (this.pending) return;
        this.pending = this.timer(() => { this.pending = null; this.scan(); }, 500);
      });
      this.observer.observe(this.doc.documentElement, {
        subtree: true, childList: true, attributes: true,
        attributeFilter: ["aria-label", "aria-hidden", "title", "data-state",
          "data-testid", "disabled", "class"]
      });
    }

    stop() {
      this.observer?.disconnect();
      if (this.pending) this.untimer(this.pending);
      this.pending = null;
      this.started = false;
    }

    scan() {
      if (!isChatGPT(this.host)) return;
      for (const signal of detect(this.doc, this.now())) {
        const key = [signal.status, signal.remaining, signal.resetAt, signal.approximate].join("|");
        if (this.lastSent.get(signal.modelId) === key) continue;
        this.lastSent.set(signal.modelId, key);
        try {
          Promise.resolve(this.onSignal(signal)).catch(() => this.lastSent.delete(signal.modelId));
        } catch { this.lastSent.delete(signal.modelId); }
      }
    }
  }

  namespace.proQuotaModel = { STORAGE_KEY, MODEL_LABELS, isChatGPT, modelFromText,
    parseResetTime, parseMessage, detect, activeStatus, Observer };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
