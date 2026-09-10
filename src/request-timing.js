(function initializeRequestTiming(namespace) {
  "use strict";

  const GPT_SITES = /^(chatgpt\.com|chat\.openai\.com)$/i;
  const isSupported = (site) => GPT_SITES.test(site) || namespace.SiteProfiles?.forSite(site)?.id === "chatgpt";

  /** Observes one ChatGPT generation without intercepting network traffic or retaining reply text. */
  class RequestTiming {
    constructor({ store, onTick, onComplete = () => {}, sample = sampleChatGPT, now = Date.now,
      interval = (callback, ms) => setInterval(callback, ms), clear = (id) => clearInterval(id) }) {
      Object.assign(this, { store, onTick, onComplete, sample, now, interval, clear });
      this.enabled = false;
      this.active = null;
    }

    /** Takes the pre-send baseline, including for Enter sends confirmed a moment later. */
    capture(site) {
      if (!this.enabled || !isSupported(site)) return null;
      try { return { startedAt: this.now(), baseline: this.sample() }; }
      catch (error) { console.warn("[AI Input History] 无法读取回复状态", error); return null; }
    }

    /** Applies the user's switch and cancels an in-progress observation when disabled. */
    setEnabled(enabled) {
      this.enabled = enabled === true;
      if (!this.enabled) this.finish("cancelled");
    }

    /** Begins an observation and returns the handle later attached to the saved send entry. */
    start(site, captured, completionContext = {}) {
      if (!this.enabled || !isSupported(site)) return null;
      this.finish("cancelled");
      const observation = captured || this.capture(site);
      if (!observation || observation.baseline.busy) return null;
      const request = {
        startedAt: observation.startedAt, path: observation.baseline.path,
        known: new Set(observation.baseline.replies.map((reply) => reply.key)),
        knownErrors: new Set(observation.baseline.errors || []), sawReply: false, quietSince: null, entryId: null, result: null,
        completionContext: { ...completionContext }
      };
      this.active = request;
      this.onTick(Math.max(0, this.now() - request.startedAt));
      this.timer = this.interval(() => this.safeTick(), 250);
      this.safeTick();
      return request;
    }

    /** Associates a finished or active observation with its actual history ID, never recreating deleted entries. */
    attach(request, entryId) {
      if (!request) return;
      request.entryId = entryId;
      if (request.result) this.persist(request);
    }

    /** Samples generation signals; elapsed time uses timestamps, not timer callback counts. */
    tick() {
      const request = this.active;
      if (!request) return;
      const elapsed = Math.max(0, this.now() - request.startedAt);
      const state = this.sample();
      if (!this.acceptPath(request, state.path)) { this.finish("cancelled"); return; }
      if ((state.errors || []).some((key) => !request.knownErrors.has(key))) { this.finish("failed"); return; }
      if (elapsed >= 20 * 60 * 1000) { this.finish("timeout"); return; }
      this.onTick(elapsed);
      const replies = state.replies.filter((reply) => !request.known.has(reply.key));
      request.sawReply ||= replies.some((reply) => reply.nonempty);
      const finished = !state.busy && request.sawReply && replies.some((reply) => reply.complete);
      if (!finished) { request.quietSince = null; return; }
      request.quietSince ??= this.now();
      if (this.now() - request.quietSince >= 500) this.finish("completed", request.quietSince);
    }

    safeTick() {
      try { this.tick(); }
      catch (error) { this.finish("failed"); console.warn("[AI Input History] 回复观察失败", error); }
    }

    acceptPath(request, path) {
      if (request.path === path) return true;
      if (!/\/c\//.test(request.path) && /\/c\//.test(path) && !request.adoptedPath) {
        request.path = path;
        request.adoptedPath = true;
        return true;
      }
      return false;
    }

    /** Stops a local observation; only a confirmed completion receives a reply timestamp and duration. */
    finish(status, completedAt = this.now()) {
      const request = this.active;
      if (!request) return;
      this.clear(this.timer);
      this.active = null;
      request.result = { status, startedAt: request.startedAt };
      if (status === "completed") Object.assign(request.result, {
        completedAt, durationMs: Math.max(0, completedAt - request.startedAt)
      });
      this.onTick(null);
      if (request.entryId) this.persist(request);
      if (status === "completed") {
        try { this.onComplete({ ...request.result, ...request.completionContext }); }
        catch (error) { console.warn("[AI Input History] 完成通知触发失败", error); }
      }
    }

    persist(request) {
      this.store.updateRequestTiming(request.entryId, request.result).catch((error) => {
        console.warn("[AI Input History] 回复耗时保存失败", error);
      });
    }
  }

  function visible(element) {
    return Boolean(element?.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
  }

  /** Reads ChatGPT's new assistant turns and completion controls; no response content is persisted. */
  function sampleChatGPT() {
    const scope = document.querySelector("main") || document;
    const busy = [...document.querySelectorAll('[data-testid="stop-button"],button[aria-label="Stop streaming"],button[aria-label="停止生成"],[data-is-streaming="true"]')].some(visible);
    const replies = [...scope.querySelectorAll('[data-message-author-role="assistant"]')].slice(-3).filter(visible).map((node) => {
      const turn = node.closest('article,[data-testid^="conversation-turn-"]') || node;
      const complete = [...turn.querySelectorAll('[data-testid="copy-turn-action-button"],[data-testid="good-response-turn-action-button"],[data-testid="bad-response-turn-action-button"]')].some(visible);
      return { key: node.getAttribute("data-message-id") || node, nonempty: Boolean(node.textContent.trim()), complete };
    });
    const errors = [...scope.querySelectorAll('[data-testid="conversation-turn-error"]')].filter(visible);
    return { path: location.pathname, busy, replies, errors };
  }

  namespace.RequestTiming = RequestTiming;
  namespace.requestTimingModel = { sampleChatGPT, isSupported };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
