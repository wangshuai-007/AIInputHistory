(function initializeRequestTiming(namespace) {
  "use strict";

  const GPT_SITES = /^(chatgpt\.com|chat\.openai\.com)$/i;
  const isSupported = (site) => GPT_SITES.test(site) || namespace.SiteProfiles?.forSite(site)?.id === "chatgpt";
  const conversationIdFromPath = (path) => {
    const match = String(path || "").match(/(?:^|\/)c\/([^/?#]+)/);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); }
    catch { return match[1]; }
  };
  const sameConversationPath = (left, right) => {
    const first = conversationIdFromPath(left);
    const second = conversationIdFromPath(right);
    return first && second ? first === second : left === right;
  };

  /** Observes one ChatGPT generation without intercepting network traffic or retaining reply text. */
  class RequestTiming {
    constructor({ store, onTick, onComplete = () => {}, onDiagnostic = () => {}, sample = sampleChatGPT, now = Date.now,
      interval = (callback, ms) => setInterval(callback, ms), clear = (id) => clearInterval(id),
      observe = observeChatGPT, session = null }) {
      Object.assign(this, { store, onTick, onComplete, onDiagnostic, sample, now, interval, clear, observe, session });
      this.enabled = false;
      this.active = null;
      this.observer = null;
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
      const observation = captured || this.capture(site);
      if (this.active && !sameConversationPath(this.active.path, observation?.baseline?.path)) this.suspend();
      else this.finish("cancelled");
      if (!observation || observation.baseline.busy) return null;
      const request = {
        requestId: `${site}:${observation.startedAt}:${Math.random().toString(16).slice(2)}`,
        site, startedAt: observation.startedAt, path: observation.baseline.path,
        conversationId: conversationIdFromPath(observation.baseline.path),
        known: new Set(observation.baseline.replies.map((reply) => reply.key)),
        knownSignatures: new Set(observation.baseline.replies.map(replySignature)),
        knownErrors: new Set(observation.baseline.errors || []), sawReply: false, sawBusy: observation.baseline.busy === true,
        quietSince: null, replyActivity: null, entryId: null, result: null, lastDeferredLog: null,
        notificationEligible: true, restored: false,
        completionContext: { ...completionContext }
      };
      this.active = request;
      this.persistSession(request);
      this.onTick(Math.max(0, this.now() - request.startedAt));
      this.timer = this.interval(() => this.safeTick("timer"), 250);
      this.startObserver();
      this.safeTick("start");
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
    async restore(site, targetPath = this.sample().path) {
      if (!this.enabled || !isSupported(site) || !this.session?.load) return null;
      if (this.active) {
        if (sameConversationPath(this.active.path, targetPath)) return this.active;
        this.suspend();
      }
      let saved;
      try { saved = await this.session.load(site, targetPath); }
      catch (error) { console.warn("[AI Input History] 读取会话 URL 计时状态失败", error); return null; }
      if (!saved || saved.site !== site || !saved.requestId || !Number.isFinite(saved.startedAt) || this.now() - saved.startedAt >= 30 * 60 * 1000) {
        if (saved) this.clearSession(saved);
        return null;
      }
      const current = this.sample();
      if (!sameConversationPath(targetPath, current.path) || this.active) return null;
      const pathMatches = sameConversationPath(saved.path, current.path)
        || (!conversationIdFromPath(saved.path) && conversationIdFromPath(current.path));
      if (!pathMatches) return null;
      const request = {
        requestId: saved.requestId,
        site, startedAt: saved.startedAt, path: current.path,
        conversationId: conversationIdFromPath(current.path),
        known: new Set(Array.isArray(saved.known) ? saved.known : []),
        knownSignatures: new Set(Array.isArray(saved.knownSignatures) ? saved.knownSignatures : []),
        knownErrors: new Set(Array.isArray(saved.knownErrors) ? saved.knownErrors : []),
        sawReply: saved.sawReply === true, sawBusy: saved.sawBusy === true,
        quietSince: null, replyActivity: null, entryId: saved.entryId || null, result: null, lastDeferredLog: null,
        notificationEligible: false, restored: true,
        adoptedPath: saved.adoptedPath === true || saved.path !== current.path,
        completionContext: saved.completionContext && typeof saved.completionContext === "object" ? { ...saved.completionContext } : {}
      };
      this.active = request;
      this.persistSession(request);
      this.onTick(Math.max(0, this.now() - request.startedAt));
      this.timer = this.interval(() => this.safeTick("timer"), 250);
      this.startObserver();
      this.safeTick("start");
      return request;
    }

    persistSession(request) {
      if (!request || !this.session?.save) return;
      const state = {
        requestId: request.requestId,
        site: request.site, startedAt: request.startedAt, path: request.path,
        conversationId: conversationIdFromPath(request.path),
        known: [...request.known].filter((value) => typeof value === "string"),
        knownSignatures: [...request.knownSignatures].filter((value) => typeof value === "string"),
        knownErrors: [...request.knownErrors].filter((value) => typeof value === "string"),
        sawReply: request.sawReply === true, sawBusy: request.sawBusy === true, entryId: request.entryId || null,
        adoptedPath: request.adoptedPath === true, completionContext: { ...request.completionContext }
      };
      Promise.resolve(this.session.save(state))
        .then((result) => {
          if (result?.saved === false && this.active?.requestId === request.requestId) this.suspend({ persist: false });
        })
        .catch((error) => console.warn("[AI Input History] 保存会话 ID 计时状态失败", error));
    }

    clearSession(request) {
      if (!this.session?.clear) return;
      const state = request ? { requestId: request.requestId, site: request.site, path: request.path } : null;
      Promise.resolve(this.session.clear(state)).catch((error) => console.warn("[AI Input History] 清理会话 URL 计时状态失败", error));
    }

    /** Samples generation signals; elapsed time uses timestamps, not timer callback counts. */
    tick(trigger = "timer") {
      const request = this.active;
      if (!request) return;
      const elapsed = Math.max(0, this.now() - request.startedAt);
      const state = this.sample();
      if (!this.acceptPath(request, state.path)) { this.suspend(); return; }
      if ((state.errors || []).some((key) => !request.knownErrors.has(key))) { this.finish("failed"); return; }
      const expired = elapsed >= 30 * 60 * 1000;
      this.onTick(elapsed);
      const replies = state.replies.filter((reply) => !request.known.has(reply.key) || !request.knownSignatures.has(replySignature(reply)));
      const sawReplyBefore = request.sawReply;
      const sawBusyBefore = request.sawBusy;
      if (request.restored && state.busy === true) request.notificationEligible = true;
      request.sawReply ||= replies.some((reply) => reply.nonempty);
      request.sawBusy ||= state.busy === true;
      if ((!sawReplyBefore && request.sawReply) || (!sawBusyBefore && request.sawBusy)) this.persistSession(request);
      const replyActivity = replies.filter((reply) => reply.nonempty)
        .map((reply) => `${reply.key}:${reply.activity || ""}`).join("|");
      if (replyActivity && replyActivity !== request.replyActivity) {
        request.replyActivity = replyActivity;
        request.quietSince = this.now();
      }
      if (state.busy) {
        const explicitComplete = replies.some((reply) => reply.complete);
        const weakStreaming = state.streamingOnly === true;
        // A stale streaming attribute cannot block an explicitly finished, stable reply forever.
        // A real Stop / processing button ALWAYS takes precedence over this fallback.
        if (weakStreaming && explicitComplete && replyActivity && request.quietSince != null
          && this.now() - request.quietSince >= 10_000) {
          request.completionTrigger = trigger;
          this.finish("completed", this.now(), { ignoreStaleStreaming: true });
          if (this.active !== request) {
            const event = { status: "completed", trigger, reason: "stale-streaming-ignored",
              elapsedMs: Math.max(0, this.now() - request.startedAt) };
            console.info("[AI Input History][ChatGPT 计时] 忽略残留生成标记，完成计时", event);
            try { this.onDiagnostic(event); }
            catch (error) { console.warn("[AI Input History] 保存计时诊断日志失败", error); }
          }
          return;
        }
        if (explicitComplete) {
          this.logDeferredFinish(request, "completed", trigger, weakStreaming ? "streaming-indicator" : state.buttonState?.reason || "processing");
        }
        if (!weakStreaming || !explicitComplete) request.quietSince = null;
        if (expired) this.finish("timeout", this.now(), { ignoreStaleStreaming: weakStreaming });
        return;
      }
      if (replyActivity && request.quietSince == null) request.quietSince = this.now();
      if (!request.sawReply || !request.quietSince) {
        if (expired) this.finish("timeout");
        return;
      }
      const explicitComplete = replies.some((reply) => reply.complete);
      const generationStopped = request.sawBusy && state.busy === false;
      if (explicitComplete || generationStopped) {
        request.completionTrigger = trigger;
        this.finish("completed", this.now());
        return;
      }
      const stableFor = this.now() - request.quietSince;
      const requiredStableMs = 10_000;
      if (stableFor >= requiredStableMs) {
        request.completionTrigger = trigger;
        this.finish("completed", this.now());
        return;
      }
      if (expired) this.finish("timeout");
    }

    safeTick(trigger = "timer") {
      try { this.tick(trigger); }
      catch (error) { this.finish("failed"); console.warn("[AI Input History] 回复观察失败", error); }
    }

    startObserver() {
      this.stopObserver();
      try { this.observer = this.observe?.(() => this.safeTick("mutation")) || null; }
      catch (error) { console.warn("[AI Input History] 无法监听后台回复变化", error); }
    }

    stopObserver() {
      try { this.observer?.disconnect?.(); }
      catch {}
      this.observer = null;
    }

    acceptPath(request, path) {
      if (request.path === path) return true;
      const knownId = conversationIdFromPath(request.path);
      const nextId = conversationIdFromPath(path);
      if ((knownId && nextId && knownId === nextId)
        || (!knownId && nextId && !request.adoptedPath)) {
        request.path = path;
        request.conversationId = nextId;
        request.adoptedPath = true;
        this.persistSession(request);
        return true;
      }
      return false;
    }

    /** Park a request when navigating elsewhere; wall-clock timing continues under its conversation ID. */
    suspend({ persist = true } = {}) {
      const request = this.active;
      if (!request) return;
      this.clear(this.timer);
      this.stopObserver();
      this.active = null;
      if (persist) this.persistSession(request);
      this.onTick(null);
    }

    /** Keep a bounded diagnostic trail without logging prompts or response text. */
    logDeferredFinish(request, status, trigger, reason) {
      const at = this.now();
      const previous = request.lastDeferredLog;
      if (previous?.status === status && previous.reason === reason && at - previous.at < 30_000) return;
      request.lastDeferredLog = { status, reason, at };
      const event = { status, trigger, reason, elapsedMs: Math.max(0, at - request.startedAt) };
      console.info("[AI Input History][ChatGPT 计时] 结束前发现仍在处理，继续计时", event);
      try { this.onDiagnostic(event); }
      catch (error) { console.warn("[AI Input History] 发送计时诊断日志失败", error); }
    }

    /** Stops a local observation; only a confirmed completion receives a reply timestamp and duration. */
    finish(status, completedAt = this.now(), options = {}) {
      const request = this.active;
      if (!request) return;
      if (["completed", "failed", "timeout"].includes(status)) {
        let latest = null;
        try { latest = this.sample(); }
        catch (error) { console.warn("[AI Input History] 结束前复核处理按钮失败", error); }
        const actualProcessingButton = latest?.buttonState?.processing === true;
        const staleStreamingAllowed = options.ignoreStaleStreaming === true
          && latest?.streamingOnly === true && latest?.buttonState?.processing === false
          && (status !== "completed" || latest.replies?.some((reply) =>
            reply.complete && (!request.known.has(reply.key) || !request.knownSignatures.has(replySignature(reply)))));
        if (actualProcessingButton || (latest?.busy && !staleStreamingAllowed)) {
          if (!request.sawBusy) { request.sawBusy = true; this.persistSession(request); }
          request.quietSince = null;
          this.logDeferredFinish(request, status, request.completionTrigger || status,
            actualProcessingButton ? latest.buttonState.reason : "streaming-indicator");
          return;
        }
      }
      this.clear(this.timer);
      this.stopObserver();
      this.active = null;
      request.result = { status, startedAt: request.startedAt, conversationId: conversationIdFromPath(request.path) };
      if (status === "completed") Object.assign(request.result, {
        completedAt, durationMs: Math.max(0, completedAt - request.startedAt),
        detectionTrigger: request.completionTrigger || "timer"
      });
      this.onTick(null);
      const commit = () => {
        if (request.entryId) this.persist(request);
        if (status === "completed") {
          try { this.onComplete({ ...request.result, ...request.completionContext, notificationEligible: request.notificationEligible !== false }); }
          catch (error) { console.warn("[AI Input History] 完成通知触发失败", error); }
        }
      };
      if (this.session?.finalize) {
        Promise.resolve(this.session.finalize({ requestId: request.requestId, site: request.site, path: request.path }, status))
          .then((result) => {
            if (result?.claimed === true) commit();
            else console.info("[AI Input History][ChatGPT 计时] 会话已由其他标签页结束，跳过重复通知", status);
          })
          .catch((error) => console.warn("[AI Input History] 会话结束状态未确认，避免重复通知", error));
      } else {
        this.clearSession(request);
        commit();
      }
    }

    persist(request) {
      this.store.updateRequestTiming(request.entryId, request.result).catch((error) => {
        console.warn("[AI Input History] 回复耗时保存失败", error);
      });
    }
  }

  function visible(element) {
    if (!element?.getClientRects().length || element.closest?.('[hidden],[aria-hidden="true"],[inert]')) return false;
    const style = getComputedStyle(element);
    return style.visibility === "visible" && Number(style.opacity) !== 0;
  }

  function replySignature(reply) {
    return `${reply?.key || ""}|${reply?.activity || ""}`;
  }

  function textFingerprint(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  }

  // Some ChatGPT variants render Stop as an unlabeled square glyph in the composer.
  const CHATGPT_STOP_ICON_PATH = "M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z";

  /** Reads only strong processing signals; an enabled Send button is not enough. */
  function readComposerButtonState(latestAssistantTurn = null) {
    const stopButtons = [
      '[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="停止生成"]',
      'button[aria-label="停止回答"]',
      'form[data-chatgpt-composer] button[aria-label="Stop"]'
    ].join(",");
    const turnSelector = '[data-turn-key],[data-testid^="conversation-turn-"],article,[data-chatgpt-search-unit-key]';
    if ([...document.querySelectorAll(stopButtons)].some((button) => {
      if (!visible(button)) return false;
      const owner = button.closest(turnSelector);
      return !owner || !latestAssistantTurn || owner === latestAssistantTurn;
    })) {
      return { processing: true, reason: "stop-button" };
    }
    const composerButtons = document.querySelectorAll([
      '#composer-submit-button', 'form[data-chatgpt-composer] button.size-token-button-composer',
      'button[data-testid="composer-submit-button"]'
    ].join(","));
    for (const button of composerButtons) {
      if (!visible(button)) continue;
      if (button.matches('[aria-busy="true"],[data-state="generating"],[data-state="processing"]')) {
        return { processing: true, reason: "composer-busy-state" };
      }
      if ([...button.querySelectorAll("svg.icon-primary-action path")].some((path) =>
        path.getAttribute("d") === CHATGPT_STOP_ICON_PATH)) {
        return { processing: true, reason: "composer-stop-icon" };
      }
      if ([...button.querySelectorAll("svg.icon-primary-action")].some((svg) => {
        const shapes = svg.querySelectorAll("rect,path,polygon,circle,ellipse,line,polyline");
        if (shapes.length !== 1 || shapes[0].tagName.toLowerCase() !== "rect") return false;
        const width = Number(shapes[0].getAttribute("width"));
        const height = Number(shapes[0].getAttribute("height"));
        return width >= 7 && width <= 16 && Math.abs(width - height) <= 1;
      })) return { processing: true, reason: "composer-stop-square" };
    }
    return { processing: false, reason: "no-stop-button" };
  }

  function observeChatGPT(callback) {
    if (typeof MutationObserver !== "function" || !document?.documentElement) return null;
    const observer = new MutationObserver(() => callback());
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "aria-busy", "data-state", "d", "data-is-streaming", "data-testid", "aria-label", "data-turn-key", "data-turn", "data-message-author-role", "data-conversation-role", "data-chatgpt-agent-turn-start", "data-markdown-text-style", "data-markdown-text-tone", "data-chatgpt-search-unit-key", "data-chatgpt-search-message-ids"]
    });
    return observer;
  }

  /** Reads ChatGPT's legacy and grouped assistant turns; no response content is persisted. */
  function sampleChatGPT() {
    const scope = document.querySelector("main") || document;
    const readySelector = [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="发送提示词"]',
      'button[aria-label="发送消息"]',
      'form[data-chatgpt-composer] button[type="submit"]'
    ].join(",");
    const ready = [...document.querySelectorAll(readySelector)]
      .some((button) => visible(button) && !button.matches("[disabled],[aria-disabled='true']"));

    const assistantMarkers = [...scope.querySelectorAll([
      '[data-turn="assistant"]',
      '[data-message-author-role="assistant"]',
      '[data-conversation-role="assistant"]',
      '[data-chatgpt-agent-turn-start]',
      '[data-chatgpt-search-unit-key$=":assistant"]',
      '[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"])'
    ].join(","))];
    const seenTurns = new Set();
    const assistantTurns = [];
    for (const marker of assistantMarkers) {
      const turn = marker.closest('[data-turn-key],[data-testid^="conversation-turn-"],article,[data-chatgpt-search-unit-key]') || marker;
      if (seenTurns.has(turn)) continue;
      const roleNode = turn.querySelector?.('[data-conversation-role="assistant"],[data-message-author-role="assistant"]') || null;
      const rolloutContent = turn.querySelector?.('[data-markdown-text-style="assistant-message"]:not([data-markdown-text-tone="tertiary"]),.markdown') || null;
      const contentNode = roleNode || rolloutContent || (marker.matches?.('[data-chatgpt-agent-turn-start]') ? turn : marker);
      if (!visible(contentNode)) continue;
      seenTurns.add(turn);
      assistantTurns.push({ marker, turn, contentNode });
    }

    const latestTurn = assistantTurns.at(-1)?.turn || null;
    const buttonState = readComposerButtonState(latestTurn);
    const turnSelector = '[data-turn-key],[data-testid^="conversation-turn-"],article,[data-chatgpt-search-unit-key]';
    const streaming = [...document.querySelectorAll('[data-is-streaming="true"]')].some((node) => {
      if (!visible(node)) return false;
      const owner = node.closest(turnSelector);
      return !owner || !latestTurn || owner === latestTurn;
    });
    const busy = buttonState.processing || streaming;
    const streamingOnly = streaming && !buttonState.processing;
    const replies = assistantTurns.slice(-3).map(({ marker, turn, contentNode }, localIndex) => {
      const groupKey = turn.getAttribute?.("data-turn-key");
      const ordinal = assistantTurns.length - Math.min(3, assistantTurns.length) + localIndex;
      const rolloutMessageIds = turn.getAttribute?.("data-chatgpt-search-message-ids");
      const rolloutUnitKey = turn.getAttribute?.("data-chatgpt-search-unit-key");
      const key = contentNode.getAttribute?.("data-message-id")
        || rolloutMessageIds
        || turn.getAttribute?.("data-turn-id")
        || turn.getAttribute?.("data-testid")
        || rolloutUnitKey
        || (groupKey ? `assistant-group:${groupKey}` : `assistant-index:${ordinal}`);
      const anchor = roleNodeForTurn(turn) || marker;
      const grouped = Boolean(groupKey);
      const actionControls = [...turn.querySelectorAll("button,[role='button']")].filter((control) => {
        if (!visible(control)) return false;
        if (!grouped || typeof anchor?.compareDocumentPosition !== "function") return !contentNode.contains(control);
        return Boolean(anchor.compareDocumentPosition(control) & 4);
      });
      const complete = actionControls.some((control) => {
        if (control.matches?.('button[data-testid="copy-turn-action-button"],.turn-action-controls button')) return true;
        const signal = [control.getAttribute("data-testid"), control.getAttribute("aria-label"), control.getAttribute("title"), control.textContent]
          .filter(Boolean).join(" ");
        return /(copy.*(turn|response)|good.*response|bad.*response|thumb|regenerate|retry|复制|赞|踩|重新生成|重试)/i.test(signal);
      });
      const text = contentNode.textContent.trim();
      const activity = textFingerprint(text);
      return { key, nonempty: Boolean(text), complete, activity };
    });
    const errors = [...scope.querySelectorAll('[data-testid="conversation-turn-error"]')].filter(visible)
      .map((node, index) => node.getAttribute("data-message-id") || node.closest('[data-testid^="conversation-turn-"],[data-turn-key]')?.getAttribute("data-testid") || `error-index:${index}`);
    return { path: location.pathname, busy, buttonState, streamingOnly, ready, replies, errors };
  }

  function roleNodeForTurn(turn) {
    return turn?.querySelector?.('[data-conversation-role="assistant"],[data-message-author-role="assistant"]') || null;
  }

  namespace.RequestTiming = RequestTiming;
  namespace.requestTimingModel = { sampleChatGPT, readComposerButtonState, isSupported,
    conversationIdFromPath, sameConversationPath };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
