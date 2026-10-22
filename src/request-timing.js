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
  // ChatGPT often starts a new response under a provisional local-chatgpt ID,
  // then replaces it with a server UUID while the answer is still streaming.
  const isTemporaryId = (id) => /^local-chatgpt:[a-z0-9-]{8,}$/i.test(id || "");
  const isServerId = (id) => /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id || "");
  function elapsedFor(request, now = Date.now()) {
    const paused = Math.max(0, Number(request?.pausedDurationMs) || 0);
    const activePause = Number.isFinite(request?.pausedAt) ? Math.max(0, now - request.pausedAt) : 0;
    return Math.max(0, now - request.startedAt - paused - activePause);
  }

  /** Observes one ChatGPT generation without intercepting network traffic or retaining reply text. */
  class RequestTiming {
    constructor({ store, onTick, onComplete = () => {}, onDiagnostic = () => {},
      onGenerationConfirmed = () => false, sample = sampleChatGPT, now = Date.now,
      interval = (callback, ms) => setInterval(callback, ms), clear = (id) => clearInterval(id),
      observe = observeChatGPT, session = null }) {
      Object.assign(this, { store, onTick, onComplete, onDiagnostic,
        onGenerationConfirmed, sample, now, interval, clear, observe, session });
      this.enabled = false;
      this.active = null;
      this.observer = null;
    }

    /** Persist only IDs and timing metadata, never the prompt or generated answer. */
    debug(request, stage, details = {}) {
      if (!request || !this.session?.debug) return;
      const at = this.now();
      try {
        Promise.resolve(this.session.debug({
          stage, requestId: request.requestId, site: request.site,
          conversationId: conversationIdFromPath(request.path),
          startedAt: request.startedAt, elapsedMs: elapsedFor(request, at),
          pausedAt: request.pausedAt, pausedDurationMs: request.pausedDurationMs || 0,
          pauseVersion: request.pauseVersion || 0, selectionKind: request.selectionKind || null,
          source: "content", ...details
        })).catch((error) => console.warn("[AI Input History] 发送计时追踪失败", error));
      } catch (error) { console.warn("[AI Input History] 发送计时追踪失败", error); }
    }

    /** Takes the pre-send baseline, including for Enter sends confirmed a moment later. */
    capture(site) {
      if (!this.enabled || !isSupported(site)) return null;
      try { return {
        startedAt: this.now(), baseline: this.sample(),
        proModelId: namespace.proUsageModel?.detect()?.id || null
      }; }
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
      // A second submit/click often arrives after the first request begins
      // streaming. Never end that request before validating a new send attempt.
      if (!observation?.baseline) {
        if (this.active) this.debug(this.active, "timing-start-ignored", {
          source: "content", reason: "send-sample-unavailable"
        });
        return null;
      }
      if (observation.baseline.busy) {
        if (this.active) this.debug(this.active, "timing-start-ignored", {
          source: "content", reason: "generation-already-active"
        });
        return null;
      }
      if (this.active && !sameConversationPath(this.active.path, observation.baseline.path)) this.suspend();
      else if (this.active) this.finish("cancelled");
      const request = {
        requestId: `${site}:${observation.startedAt}:${Math.random().toString(16).slice(2)}`,
        site, startedAt: observation.startedAt, path: observation.baseline.path,
        conversationId: conversationIdFromPath(observation.baseline.path),
        known: new Set(observation.baseline.replies.map((reply) => reply.key)),
        knownSignatures: new Set(observation.baseline.replies.map(replySignature)),
        knownErrors: new Set(observation.baseline.errors || []), sawReply: false, sawBusy: observation.baseline.busy === true,
        quietSince: null, replyActivity: null, entryId: null, result: null, lastDeferredLog: null,
        notificationEligible: true, restored: false, pausedDurationMs: 0, pausedAt: null, pauseVersion: 0,
        lastBusyAt: null,
        manualPause: false, selectionKind: null,
        proModelId: ["gpt-6-pro", "gpt-5.6-pro", "pro"].includes(observation.proModelId) ? observation.proModelId : null,
        proUsageEligible: completionContext.countProUsage === true,
        sidebarUnreadCleared: completionContext.sidebarUnreadAtStart !== true,
        completionContext: { ...completionContext }
      };
      this.active = request;
      this.persistSession(request);
      if (completionContext.countProUsage === true) {
        this.debug(request, "pro-model-sampled", {
          source: "content", model: request.proModelId || null,
          reason: request.proModelId ? "selected-pro-mode" : "pro-mode-not-confirmed"
        });
      }
      this.onTick(elapsedFor(request, this.now()), Number.isFinite(request.pausedAt));
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
      if (!saved || saved.site !== site || !saved.requestId || !Number.isFinite(saved.startedAt)
        || this.now() - (Number.isFinite(saved.pausedAt) ? saved.startedAt
          : Math.max(saved.startedAt, Number.isFinite(saved.lastBusyAt)
            ? Math.min(this.now(), saved.lastBusyAt) : saved.startedAt))
          >= (Number.isFinite(saved.pausedAt) ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000)) {
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
        lastBusyAt: Number.isFinite(saved.lastBusyAt) ? saved.lastBusyAt : null,
        quietSince: null, replyActivity: null, entryId: saved.entryId || null, result: null, lastDeferredLog: null,
        pausedDurationMs: Number(saved.pausedDurationMs) || 0, pausedAt: Number.isFinite(saved.pausedAt) ? saved.pausedAt : null,
        pauseVersion: Number(saved.pauseVersion) || 0, sidebarUnreadCleared: saved.sidebarUnreadCleared === true,
        manualPause: saved.manualPause === true,
        selectionKind: saved.selectionKind || null,
        proModelId: saved.proModelId || null, proUsageEligible: false,
        notificationEligible: current.busy === true && current.streamingOnly !== true && (
          !Array.isArray(current.userActivities) || !current.userActivities.length ||
          !saved.completionContext?.promptText ||
          current.userActivities.includes(textFingerprint(normalizePrompt(saved.completionContext.promptText)))
        ), restored: true, restoredAt: this.now(), identityMismatchSince: null,
        adoptedPath: saved.adoptedPath === true || saved.path !== current.path,
        serverIdAdopted: saved.serverIdAdopted === true,
        completionContext: saved.completionContext && typeof saved.completionContext === "object" ? { ...saved.completionContext } : {}
      };
      this.active = request;
      this.persistSession(request);
      this.onTick(elapsedFor(request, this.now()), Number.isFinite(request.pausedAt));
      this.timer = this.interval(() => this.safeTick("timer"), 250);
      this.startObserver();
      this.debug(request, "timing-observer-restored", { source: "content", reason: "session-restored" });
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
        lastBusyAt: Number.isFinite(request.lastBusyAt) ? request.lastBusyAt : null,
        adoptedPath: request.adoptedPath === true, serverIdAdopted: request.serverIdAdopted === true,
        completionContext: { ...request.completionContext },
        pausedDurationMs: request.pausedDurationMs || 0, pausedAt: request.pausedAt,
        pauseVersion: request.pauseVersion || 0, sidebarUnreadCleared: request.sidebarUnreadCleared !== false,
        manualPause: request.manualPause === true, selectionKind: request.selectionKind || null,
        proModelId: request.proModelId || null, proUsageEligible: request.proUsageEligible === true,
        lastTransitionReason: request.lastTransitionReason || null
      };
      Promise.resolve(this.session.save(state))
        .then((result) => {
          if (result?.saved === false && this.active?.requestId === request.requestId) {
            this.debug(request, "timing-session-save-rejected", {
              source: "background", reason: result.reason || "unknown"
            });
            this.suspend({ persist: false });
          }
        })
        .catch((error) => console.warn("[AI Input History] 保存会话 ID 计时状态失败", error));
    }

    clearSession(request) {
      if (!this.session?.clear) return;
      const state = request ? { requestId: request.requestId, site: request.site, path: request.path } : null;
      Promise.resolve(this.session.clear(state)).catch((error) => console.warn("[AI Input History] 清理会话 URL 计时状态失败", error));
    }

    /** Applies pause updates from other tabs without generating a save loop. */
    syncPause(state) {
      const request = this.active;
      if (!request || request.requestId !== state?.requestId ||
        !(Number(state.pauseVersion) > (request.pauseVersion || 0))) return;
      request.pausedAt = Number.isFinite(state.pausedAt) ? state.pausedAt : null;
      request.pausedDurationMs = Math.max(0, Number(state.pausedDurationMs) || 0);
      request.pauseVersion = state.pauseVersion;
      request.manualPause = state.manualPause === true;
      this.onTick(elapsedFor(request, this.now()), Number.isFinite(request.pausedAt));
      this.debug(request, "timing-pause-synchronized", {
        source: "content", reason: "another-tab-storage-change",
        status: Number.isFinite(request.pausedAt) ? "paused" : "running"
      });
    }

    setPaused(value, reason = "page") {
      const request = this.active;
      if (!request) return;
      const paused = Number.isFinite(request.pausedAt);
      if (paused === Boolean(value)) return;
      const at = this.now();
      if (value) request.pausedAt = at;
      else {
        request.pausedDurationMs = (request.pausedDurationMs || 0) + Math.max(0, at - request.pausedAt);
        request.pausedAt = null;
      }
      request.pauseVersion = Math.max(at, (request.pauseVersion || 0) + 1);
      request.lastTransitionReason = reason;
      this.persistSession(request);
      this.onTick(elapsedFor(request, at), Boolean(value));
    }

    selectionMade() {
      const request = this.active;
      if (!request || !Number.isFinite(request.pausedAt)) return;
      try { request.selectedTurnKey = this.sample().selectionTurnKey || ""; } catch {}
      request.manualPause = false;
      this.setPaused(false, "selection");
    }

    /** Undo a tentative pause caused by ordinary reply action buttons.
     * This is not user think-time, so keep it in the final elapsed duration. */
    revokeInferredPause(request) {
      if (!request || !Number.isFinite(request.pausedAt) || request.manualPause === true) return;
      const at = this.now();
      const discardedMs = Math.max(0, at - request.pausedAt);
      request.pausedAt = null;
      request.selectionKind = null;
      request.pauseVersion = Math.max(at, (request.pauseVersion || 0) + 1);
      request.lastTransitionReason = "false-selection-recovered";
      this.persistSession(request);
      this.onTick(elapsedFor(request, at), false);
      this.debug(request, "timing-false-selection-recovered", {
        source: "content", reason: "reply-finished-without-real-choice",
        selectionKind: "inferred", pauseDeltaMs: discardedMs
      });
    }

    /** Samples generation signals; elapsed time uses timestamps, not timer callback counts. */
    tick(trigger = "timer") {
      const request = this.active;
      if (!request) return;
      const state = this.sample();
      if (!this.acceptPath(request, state.path)) {
        this.debug(request, "timing-route-mismatch", {
          source: "content", reason: "different-conversation-route",
          targetConversationId: conversationIdFromPath(state.path)
        });
        this.suspend();
        return;
      }
      if (request.restored && Array.isArray(state.userActivities) && state.userActivities.length
        && request.completionContext?.promptText
        && !state.userActivities.includes(textFingerprint(normalizePrompt(request.completionContext.promptText)))) {
        this.onTick(elapsedFor(request, this.now()), Number.isFinite(request.pausedAt));
        this.logDeferredFinish(request, "restoring", trigger, "conversation-content-not-ready");
        return;
      }
      // During SPA restoration, the old conversation's assistant turn can still
      // be mounted briefly, even when its user text has not been rendered yet.
      if (request.restored && this.now() - request.restoredAt < 600) {
        this.onTick(elapsedFor(request, this.now()), Number.isFinite(request.pausedAt));
        return;
      }
      // Evaluate completion before returning from a paused timer. Previously a
      // heuristic choice kept this branch permanently paused even after the
      // assistant produced its final Copy/Retry controls.
      const replyCandidates = request.restored && state.replies.some((reply) => typeof reply.afterLatestUser === "boolean")
        ? state.replies.filter((reply) => reply.afterLatestUser !== false)
        : state.replies;
      const replies = replyCandidates.filter((reply) => !request.known.has(reply.key) || !request.knownSignatures.has(replySignature(reply)));
      const finishedReply = state.busy === false && replies.some((reply) =>
        reply.nonempty && reply.complete && reply.afterLatestUser !== false);
      if (state.busy === true && (request.lastBusyAt == null || this.now() - request.lastBusyAt >= 4_000)) {
        request.lastBusyAt = this.now();
        this.persistSession(request);
      }
      // A confirmed assistant generation is a second, independent evidence
      // source for counting Pro sends. A click/submit may have started the
      // timer while a React composer replacement prevented emit()/recordSend.
      // Retry periodically until the Pro mode can be identified. Never count
      // a restored timer simply because the page is still streaming.
      if (state.busy === true && !request.restored && !request.generationSignalSent
        && (!request.lastGenerationSignalAt || this.now() - request.lastGenerationSignalAt >= 900)) {
        request.lastGenerationSignalAt = this.now();
        try {
          if (this.onGenerationConfirmed(request) === true) request.generationSignalSent = true;
        } catch (error) {
          this.debug(request, "pro-generation-confirmation-failed", {
            source: "content", reason: "generation-callback-error"
          });
        }
      }
      const shouldPause = state.waitingForSelection === true
        && (!request.selectedTurnKey || request.selectedTurnKey !== state.selectionTurnKey)
        && !(state.selectionKind === "inferred" && finishedReply);
      if (shouldPause && !Number.isFinite(request.pausedAt)) {
        request.selectionKind = state.selectionKind || "explicit";
        this.setPaused(true, "selection");
      } else if (Number.isFinite(request.pausedAt) && request.manualPause !== true && !shouldPause) {
        if (request.selectionKind === "inferred" && !state.busy
          && replies.some((reply) => reply.nonempty)) {
          this.revokeInferredPause(request);
        } else if ((state.busy === true && state.streamingOnly !== true && state.buttonState?.processing === true)
          || finishedReply || (!state.waitingForSelection && replies.some((reply) => reply.nonempty))) {
          this.setPaused(false, finishedReply ? "reply-completed-after-selection" : "reply-resumed");
        }
      }
      const elapsed = elapsedFor(request, this.now());
      this.onTick(elapsed, Number.isFinite(request.pausedAt));
      // A manual or genuinely awaited choice can remain paused, but a complete
      // reply with no remaining active choice must be allowed to finalize.
      if (Number.isFinite(request.pausedAt)) {
        if (finishedReply && !shouldPause) {
          request.completionTrigger = trigger;
          this.finish("completed", this.now());
        } else if (finishedReply && shouldPause) {
          this.logDeferredFinish(request, "waiting", trigger, "awaiting-explicit-user-choice");
        }
        return;
      }
      if (request.restored) {
        // SPA navigation changes the URL before React replaces the previous transcript.
        // Never decide completion from another conversation's old assistant turn.
        const sentPrompt = request.completionContext?.promptText;
        const expected = sentPrompt ? textFingerprint(normalizePrompt(sentPrompt)) : null;
        const visibleUserTurns = state.userActivities;
        const unrelatedTranscript = expected && Array.isArray(visibleUserTurns) && visibleUserTurns.length
          && !visibleUserTurns.includes(expected);
        if (unrelatedTranscript) {
          if (request.identityMismatchSince == null) request.identityMismatchSince = this.now();
          this.logDeferredFinish(request, "restoring", trigger, "conversation-content-not-ready");
          return;
        }
        request.identityMismatchSince = null;
        // A transient idle state immediately after navigation is not evidence that a
        // generation finished. Give the UI a chance to mount the correct response.
        if (this.now() - request.restoredAt < 600) return;
      }
      if ((state.errors || []).some((key) => !request.knownErrors.has(key))) { this.finish("failed"); return; }
      const expired = elapsed >= 30 * 60 * 1000;
      const sawReplyBefore = request.sawReply;
      const sawBusyBefore = request.sawBusy;
      if (request.restored && state.busy === true && state.streamingOnly !== true) request.notificationEligible = true;
      request.sawReply ||= replies.some((reply) => reply.nonempty);
      request.sawBusy ||= state.busy === true;
      // A live generation heartbeat prevents an unrelated browser tab from
      // declaring completion just because the sidebar has a stale unread dot.
      const refreshHeartbeat = state.busy === true && (request.lastBusyAt == null
        || this.now() - request.lastBusyAt >= 4_000);
      if (refreshHeartbeat) request.lastBusyAt = this.now();
      if (refreshHeartbeat || (!sawReplyBefore && request.sawReply)
        || (!sawBusyBefore && request.sawBusy)) this.persistSession(request);
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
              elapsedMs: elapsedFor(request, this.now()) };
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
      // On revisit the response may have finished while its page was unmounted.
      // Some ChatGPT layouts omit Copy/Retry controls. After verifying the
      // correct conversation and absence of a real Stop button, use a shorter
      // text-stability window rather than leaving the clock running indefinitely.
      const requiredStableMs = request.restored && request.notificationEligible === false ? 3_000 : 10_000;
      if (stableFor >= requiredStableMs) {
        request.completionTrigger = trigger;
        this.finish("completed", this.now());
        return;
      }
      if (expired) this.finish("timeout");
    }

    safeTick(trigger = "timer") {
      try { this.tick(trigger); }
      catch (error) {
        // A transient React DOM remount is not evidence that the generation
        // failed. Keep observing and retry instead of hiding the clock.
        const request = this.active;
        if (request) {
          try { this.onTick(elapsedFor(request, this.now()), Number.isFinite(request.pausedAt)); }
          catch (renderError) { console.warn("[AI Input History] Timer view error", renderError); }
          const at = this.now();
          if (!request.lastSampleErrorAt || at - request.lastSampleErrorAt >= 30_000) {
            request.lastSampleErrorAt = at;
            this.debug(request, "timing-sample-error", {
              source: "content", reason: "transient-dom-sample-error",
              trigger, error: String(error?.message || error).slice(0, 180)
            });
          }
        }
        console.warn("[AI Input History] Sample failed; timer preserved", error);
      }
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
      const provisionalUpgrade = isTemporaryId(knownId) && isServerId(nextId)
        && !request.serverIdAdopted && this.now() - request.startedAt < 30 * 60 * 1000;
      if ((knownId && nextId && knownId === nextId)
        || (!knownId && nextId && !request.adoptedPath)
        || provisionalUpgrade) {
        const previousId = knownId;
        request.path = path;
        request.conversationId = nextId;
        request.adoptedPath = true;
        if (provisionalUpgrade) {
          request.serverIdAdopted = true;
          this.debug(request, "timing-conversation-id-upgraded", {
            source: "content", reason: "temporary-chatgpt-id-to-server-uuid",
            previousIdKind: "temporary", status: "running"
          });
        }
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
      this.debug(request, "timing-observer-suspended", {
        source: "content", reason: persist ? "navigated-away" : "state-replaced-or-finalized",
        status: Number.isFinite(request.pausedAt) ? "paused" : "running"
      });
      this.onTick(null);
    }

    /** Keep a bounded diagnostic trail without logging prompts or response text. */
    logDeferredFinish(request, status, trigger, reason) {
      const at = this.now();
      const previous = request.lastDeferredLog;
      if (previous?.status === status && previous.reason === reason && at - previous.at < 30_000) return;
      request.lastDeferredLog = { status, reason, at };
      const event = {
        status, trigger, reason, elapsedMs: elapsedFor(request, at),
        requestId: request.requestId, conversationId: conversationIdFromPath(request.path),
        pausedDurationMs: request.pausedDurationMs || 0
      };
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
      this.debug(request, "timing-observation-ending", {
        source: "content", status, trigger: request.completionTrigger || status,
        reason: status === "cancelled" ? "request-cancelled" : "confirmed-observation-end"
      });
      this.clear(this.timer);
      this.stopObserver();
      this.active = null;
      request.result = { status, startedAt: request.startedAt, conversationId: conversationIdFromPath(request.path) };
      if (status === "completed") Object.assign(request.result, {
        completedAt, durationMs: elapsedFor(request, completedAt),
        detectionTrigger: request.completionTrigger || "timer",
        observedAfterResume: request.restored === true && request.notificationEligible === false
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

  function normalizePrompt(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
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

  const CHOICE_SELECTOR = [
    'input[type="radio"]', '[role="radio"]', '[role="option"]', '[role="listbox"]',
    'button[data-choice-id]', 'button[data-testid*="choice"]',
    'button[data-testid*="option"]', '[data-testid="interaction-request"]',
    '[data-chatgpt-interaction]', '[data-state="awaiting-user"]'
  ].join(",");
  const CHOICE_PROMPT = /(?:please (?:choose|select|confirm)|(?:choose|select) (?:one|an option|from)|which (?:option|would you prefer)|approval required|请选择|请选择一项|选择一个|请确认(?:选项|操作)|等待(?:选择|用户输入))/i;
  const COMMON_REPLY_ACTION = /(?:copy|regenerate|retry|thumb|share|edit|read aloud|more actions|view sources|citation|feedback|like|dislike|复制|重试|重新生成|分享|朗读|点赞|踩|停止|取消|更多|引用|来源|反馈)/i;

  function selectionControls(content) {
    if (!content?.querySelectorAll) return { controls: [], kind: null };
    const explicit = [...content.querySelectorAll(CHOICE_SELECTOR)].filter(visible);
    if (explicit.length) return { controls: explicit, kind: "explicit" };
    // Ordinary completed assistant turns can have several action buttons (More,
    // sources, etc.). Counting any two buttons as choices can pause a finished
    // reply forever. Only infer a choice if the assistant explicitly asks for one.
    const candidates = [...content.querySelectorAll("button,input[type='checkbox'],select")].filter((button) => {
      if (!visible(button) || button.disabled) return false;
      const label = [button.getAttribute("aria-label"), button.getAttribute("data-testid"),
        button.textContent].filter(Boolean).join(" ").trim();
      return label.length > 0 && label.length < 105 && !COMMON_REPLY_ACTION.test(label);
    });
    return candidates.length >= 2 && CHOICE_PROMPT.test(content.textContent || "")
      ? { controls: candidates, kind: "inferred" } : { controls: [], kind: null };
  }

  function isSelectionControl(node) {
    if (!node?.closest || typeof document === "undefined") return false;
    const target = node.closest('button,[role="option"],[role="radio"],input,select');
    if (!target || target.disabled) return false;
    const scope = document.querySelector("main") || document;
    const turns = [...scope.querySelectorAll('[data-turn="assistant"],[data-message-author-role="assistant"],[data-conversation-role="assistant"],[data-chatgpt-search-unit-key$=":assistant"]')];
    const latest = turns.at(-1);
    if (!latest) return false;
    const turn = latest.closest('[data-turn-key],[data-testid^="conversation-turn-"],article') || latest;
    return selectionControls(turn).controls.some((control) => control === target || control.contains(target));
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

    const userMarkers = [...scope.querySelectorAll('[data-message-author-role="user"],[data-user-message-bubble]')]
      .filter(visible);
    const latestUserMarker = userMarkers.at(-1) || null;
    const latestTurn = assistantTurns.at(-1)?.turn || null;
    const selection = latestTurn ? selectionControls(latestTurn) : { controls: [], kind: null };
    const choiceNodes = selection.controls;
    const latestSelectionReply = latestTurn?.querySelector('[data-message-author-role="assistant"],[data-conversation-role="assistant"]') || latestTurn;
    const selectionAfterUser = !latestUserMarker || Boolean(latestUserMarker.compareDocumentPosition(latestTurn) & 4);
    const selectionTurnKey = latestSelectionReply?.getAttribute("data-message-id")
      || latestTurn?.getAttribute("data-turn-id") || latestTurn?.getAttribute("data-testid")
      || latestTurn?.getAttribute("data-chatgpt-search-message-ids") || "";
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
      const afterLatestUser = !latestUserMarker || Boolean(latestUserMarker.compareDocumentPosition(turn) & 4);
      return { key, nonempty: Boolean(text), complete, activity, afterLatestUser };
    });
    // On SPA navigation, location.pathname changes before the previous conversation's
    // transcript is unmounted. Keep only hashed user turns so a restored timer cannot
    // treat another conversation's finished assistant turn as its own completion.
    const userActivities = userMarkers.slice(-20)
      .map((node) => textFingerprint(normalizePrompt(node.textContent)));

    const errors = [...scope.querySelectorAll('[data-testid="conversation-turn-error"]')].filter(visible)
      .map((node, index) => node.getAttribute("data-message-id") || node.closest('[data-testid^="conversation-turn-"],[data-turn-key]')?.getAttribute("data-testid") || `error-index:${index}`);
    return { path: location.pathname, busy, buttonState, streamingOnly, ready, replies, userActivities,
      waitingForSelection: choiceNodes.length > 0 && selectionAfterUser,
      selectionKind: selection.kind, selectionTurnKey, errors };
  }

  function roleNodeForTurn(turn) {
    return turn?.querySelector?.('[data-conversation-role="assistant"],[data-message-author-role="assistant"]') || null;
  }

  namespace.RequestTiming = RequestTiming;
  namespace.requestTimingModel = { sampleChatGPT, readComposerButtonState, isSupported,
    conversationIdFromPath, sameConversationPath, isTemporaryId, isServerId, elapsedFor, isSelectionControl,
    promptFingerprint: (value) => textFingerprint(normalizePrompt(value)) };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
