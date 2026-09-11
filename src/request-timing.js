(function initializeRequestTiming(namespace) {
  "use strict";

  const GPT_SITES = /^(chatgpt\.com|chat\.openai\.com)$/i;
  const isSupported = (site) => GPT_SITES.test(site) || namespace.SiteProfiles?.forSite(site)?.id === "chatgpt";

  /** Observes one ChatGPT generation without intercepting network traffic or retaining reply text. */
  class RequestTiming {
    constructor({ store, onTick, onComplete = () => {}, sample = sampleChatGPT, now = Date.now,
      interval = (callback, ms) => setInterval(callback, ms), clear = (id) => clearInterval(id), session = null }) {
      Object.assign(this, { store, onTick, onComplete, sample, now, interval, clear, session });
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
        requestId: `${site}:${observation.startedAt}:${Math.random().toString(16).slice(2)}`,
        site, startedAt: observation.startedAt, path: observation.baseline.path,
        known: new Set(observation.baseline.replies.map((reply) => reply.key)),
        knownErrors: new Set(observation.baseline.errors || []), sawReply: false, sawBusy: observation.baseline.busy === true,
        quietSince: null, replyActivity: null, entryId: null, result: null,
        completionContext: { ...completionContext }
      };
      this.active = request;
      this.persistSession(request);
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
      else this.persistSession(request);
    }

    /** Restores an in-progress observation for the same ChatGPT conversation URL. */
    async restore(site) {
      if (!this.enabled || !isSupported(site) || !this.session?.load) return null;
      let saved;
      try { saved = await this.session.load(); }
      catch (error) { console.warn("[AI Input History] 读取会话 URL 计时状态失败", error); return null; }
      if (!saved || saved.site !== site || !saved.requestId || !Number.isFinite(saved.startedAt) || this.now() - saved.startedAt >= 30 * 60 * 1000) {
        if (saved) this.clearSession(saved);
        return null;
      }
      const current = this.sample();
      const pathMatches = saved.path === current.path || (!/\/c\//.test(saved.path || "") && /\/c\//.test(current.path || ""));
      if (!pathMatches) { this.clearSession(saved); return null; }
      const request = {
        requestId: saved.requestId,
        site, startedAt: saved.startedAt, path: current.path,
        known: new Set(Array.isArray(saved.known) ? saved.known : []),
        knownErrors: new Set(Array.isArray(saved.knownErrors) ? saved.knownErrors : []),
        sawReply: saved.sawReply === true, sawBusy: saved.sawBusy === true,
        quietSince: null, replyActivity: null, entryId: saved.entryId || null, result: null,
        adoptedPath: saved.adoptedPath === true || saved.path !== current.path,
        completionContext: saved.completionContext && typeof saved.completionContext === "object" ? { ...saved.completionContext } : {}
      };
      this.active = request;
      this.persistSession(request);
      this.onTick(Math.max(0, this.now() - request.startedAt));
      this.timer = this.interval(() => this.safeTick(), 250);
      this.safeTick();
      return request;
    }

    persistSession(request) {
      if (!request || !this.session?.save) return;
      const state = {
        requestId: request.requestId,
        site: request.site, startedAt: request.startedAt, path: request.path,
        known: [...request.known].filter((value) => typeof value === "string"),
        knownErrors: [...request.knownErrors].filter((value) => typeof value === "string"),
        sawReply: request.sawReply === true, sawBusy: request.sawBusy === true, entryId: request.entryId || null,
        adoptedPath: request.adoptedPath === true, completionContext: { ...request.completionContext }
      };
      Promise.resolve(this.session.save(state)).catch((error) => console.warn("[AI Input History] 保存会话 URL 计时状态失败", error));
    }

    clearSession(request) {
      if (!this.session?.clear) return;
      const state = request ? { requestId: request.requestId, site: request.site, path: request.path } : null;
      Promise.resolve(this.session.clear(state)).catch((error) => console.warn("[AI Input History] 清理会话 URL 计时状态失败", error));
    }

    /** Samples generation signals; elapsed time uses timestamps, not timer callback counts. */
    tick() {
      const request = this.active;
      if (!request) return;
      const elapsed = Math.max(0, this.now() - request.startedAt);
      const state = this.sample();
      if (!this.acceptPath(request, state.path)) { this.finish("cancelled"); return; }
      if ((state.errors || []).some((key) => !request.knownErrors.has(key))) { this.finish("failed"); return; }
      if (elapsed >= 30 * 60 * 1000) { this.finish("timeout"); return; }
      this.onTick(elapsed);
      const replies = state.replies.filter((reply) => !request.known.has(reply.key));
      const sawReplyBefore = request.sawReply;
      const sawBusyBefore = request.sawBusy;
      request.sawReply ||= replies.some((reply) => reply.nonempty);
      request.sawBusy ||= state.busy === true;
      if ((!sawReplyBefore && request.sawReply) || (!sawBusyBefore && request.sawBusy)) this.persistSession(request);
      const replyActivity = replies.filter((reply) => reply.nonempty)
        .map((reply) => `${reply.key}:${reply.activity || ""}`).join("|");
      if (replyActivity && replyActivity !== request.replyActivity) {
        request.replyActivity = replyActivity;
        request.quietSince = this.now();
      }
      if (state.busy) { request.quietSince = null; return; }
      if (replyActivity && request.quietSince == null) request.quietSince = this.now();
      if (!request.sawReply || !request.quietSince) return;
      const strongCompletionSignal = state.ready === true || request.sawBusy || replies.some((reply) => reply.complete);
      const stableFor = this.now() - request.quietSince;
      if (stableFor >= (strongCompletionSignal ? 500 : 1250)) this.finish("completed", request.quietSince);
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
        this.persistSession(request);
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
      this.clearSession(request);
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
    const ready = [...document.querySelectorAll('[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[aria-label="发送提示词"],button[aria-label="发送消息"]')]
      .some((button) => visible(button) && !button.matches("[disabled],[aria-disabled='true']"));
    const assistantNodes = [...scope.querySelectorAll('[data-message-author-role="assistant"]')].filter(visible);
    const replies = assistantNodes.slice(-3).map((node) => {
      const turn = node.closest('article,[data-testid^="conversation-turn-"]') || node;
      const ordinal = assistantNodes.indexOf(node);
      const key = node.getAttribute("data-message-id") || turn.getAttribute?.("data-testid") || `assistant-index:${ordinal}`;
      const complete = [...turn.querySelectorAll('[data-testid="copy-turn-action-button"],[data-testid="good-response-turn-action-button"],[data-testid="bad-response-turn-action-button"]')].some(visible);
      const text = node.textContent.trim();
      const activity = `${text.length}:${turn.querySelectorAll("*").length}`;
      return { key, nonempty: Boolean(text), complete, activity };
    });
    const errors = [...scope.querySelectorAll('[data-testid="conversation-turn-error"]')].filter(visible)
      .map((node, index) => node.getAttribute("data-message-id") || node.closest('[data-testid^="conversation-turn-"]')?.getAttribute("data-testid") || `error-index:${index}`);
    return { path: location.pathname, busy, ready, replies, errors };
  }

  namespace.RequestTiming = RequestTiming;
  namespace.requestTimingModel = { sampleChatGPT, isSupported };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
