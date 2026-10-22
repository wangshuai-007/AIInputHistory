(function initializeSidebarTiming(namespace) {
  "use strict";

  const KEY = "aiInputHistoryActiveTimingByUrl";
  const BADGE = "data-aih-sidebar-timer";
  const getId = (path) => namespace.requestTimingModel?.conversationIdFromPath(path) || null;

  function conversationIdFromLink(href, origin) {
    try {
      const target = new URL(href, origin);
      if (target.origin !== new URL(origin).origin) return null;
      return getId(target.pathname);
    } catch { return null; }
  }

  function isMarked(root, selectors) {
    try { return Boolean(root.matches?.(selectors) || root.querySelector?.(selectors)); }
    catch { return false; }
  }

  // ChatGPT may render the status icon beside <a>, not inside it. Only inspect
  // ancestors containing links to THIS conversation, never the whole list.
  function statusScopeForLink(link, origin) {
    const id = conversationIdFromLink(link?.getAttribute?.("href"), origin);
    if (!id) return link;
    let scope = link;
    let ancestor = link?.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth++, ancestor = ancestor.parentElement) {
      const anchors = [...(ancestor.querySelectorAll?.('a[href*="/c/"]') || [])];
      if (!anchors.length || anchors.length > 5 || anchors.some((row) =>
        conversationIdFromLink(row.getAttribute?.("href"), origin) !== id)) break;
      scope = ancestor;
    }
    return scope;
  }

  const STATUS_WORDS = {
    paused: /(?:\b(?:paused|awaiting(?: user| input| choice| approval)?|waiting for (?:your|user) (?:input|response|approval)|needs (?:your )?(?:input|attention|approval)|action required|approval required|review required|requires action)\b|暂停|等待(?:用户|选择|输入|确认|审批|操作)|需要(?:您|用户)?(?:操作|确认|审批)|待审批)/i,
    running: /(?:\b(?:running|generating|in progress|working|processing|streaming)\b|正在(?:生成|运行|处理|回复)|生成中|处理中)/i,
    completed: /(?:\b(?:completed|complete|reply ready|response ready|finished)\b|已完成|回复完成)/i
  };

  /** Read dedicated status/tooltip attributes, never ordinary conversation-title text. */
  function explicitStatusText(scope) {
    const nodes = [scope, ...(scope?.querySelectorAll?.(
      '[role="status"],[data-testid*="status"],[data-conversation-status],'+
      '[data-state],[aria-label],[title],button[title],button[aria-label]'
    ) || [])];
    const statuses = [];
    for (const node of nodes.slice(0, 55)) {
      // Our own timer tooltip must never be treated as ChatGPT's status.
      if (node?.closest?.("[" + BADGE + "]") || node?.getAttribute?.(BADGE) !== null
        && node?.getAttribute?.(BADGE) !== undefined) continue;
      for (const name of ["data-conversation-status", "data-state", "aria-label", "title"]) {
        const value = node?.getAttribute?.(name);
        if (!value || value.length > 100) continue;
        const exactStatus = /^(?:paused|awaiting (?:input|user|choice|approval)|waiting for (?:your|user) (?:input|response|approval)|needs (?:your )?(?:input|attention|approval)|generating|running|working|completed|finished|暂停|等待选择|等待输入|等待确认|等待审批|正在生成|生成中|已完成)$/i.test(value.trim());
        const isStatusNode = name === "data-conversation-status" || name === "data-state"
          || node !== scope && (["status", "img", "progressbar"].includes(node?.getAttribute?.("role"))
            || /status|activity|state|pause|progress|await/i.test(node?.getAttribute?.("data-testid") || "")
            || node?.matches?.("svg,button,[role='img']")
            || exactStatus && !node?.matches?.("a[href]"));
        if (!isStatusNode) continue;
        if (STATUS_WORDS.paused.test(value)) statuses.push("paused");
        else if (STATUS_WORDS.running.test(value)) statuses.push("running");
        else if (STATUS_WORDS.completed.test(value)) statuses.push("completed");
      }
    }
    return statuses;
  }

  /** Only explicit status metadata/icons. Conversation titles are untrusted arbitrary text. */
  function readSidebarStatus(link, origin = globalThis.location?.origin || "https://chatgpt.com") {
    if (!link) return "unknown";
    const scope = statusScopeForLink(link, origin);
    const unread = [
      '[data-conversation-unread="true"]', '[data-testid*="unread-indicator"]',
      '[data-testid="unread-dot"]', '[data-state="unread"]',
      '[aria-label="Unread"]', '[aria-label="未读"]', '[title="Unread"]',
      '[title="未读"]', '[data-aih-test-status="completed"]'
    ].join(",");
    const paused = [
      '[data-conversation-status="paused"]', '[data-conversation-status="waiting_for_input"]',
      '[data-state="waiting-for-user"]', '[data-state="awaiting-user"]',
      '[data-testid="conversation-paused"]', '[data-testid="conversation-awaiting-input"]',
      '[aria-label="Waiting for your input"]', '[aria-label="Needs your input"]',
      '[aria-label="等待用户输入"]', '[aria-label="等待选择"]',
      '[data-aih-test-status="paused"]'
    ].join(",");
    const running = [
      '[data-conversation-status="running"]', '[data-conversation-status="generating"]',
      '[data-state="generating"]', '[data-testid="conversation-generating"]',
      '[data-testid="conversation-running"]', '[aria-label="Generating"]',
      '[aria-label="正在生成"]', '[aria-busy="true"]', '[data-aih-test-status="running"]'
    ].join(",");
    // Running and waiting explicitly take precedence over a stale unread icon.
    const words = explicitStatusText(scope);
    // Explicit waiting/paused signals outweigh stale running markers on the same row.
    if (isMarked(scope, paused) || words.includes("paused")) return "paused";
    if (isMarked(scope, running) || words.includes("running")) return "running";
    if (words.includes("completed")) return "completed";
    if (isMarked(scope, unread)) return "completed";
    return "unknown";
  }

  function elapsedMs(state, now = Date.now()) {
    const since = Number(state?.startedAt);
    if (!Number.isFinite(since)) return 0;
    const pause = Math.max(0, Number(state.pausedDurationMs) || 0);
    const ongoing = Number.isFinite(state.pausedAt) ? Math.max(0, now - state.pausedAt) : 0;
    return Math.max(0, now - since - pause - ongoing);
  }

  function formatElapsed(elapsed) {
    const seconds = Math.floor(Math.max(0, elapsed) / 1000);
    if (seconds < 60) return seconds + "s";
    return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  }

  class SidebarTiming {
    constructor({ site = location.hostname, origin = location.origin, now = Date.now,
      onStatus = () => {}, onDiagnostic = () => {}, getPath = () => location.pathname,
      documentRef = document, timer = (callback, delay) => setInterval(callback, delay),
      untimer = (id) => clearInterval(id) } = {}) {
      Object.assign(this, { site, origin, now, onStatus, onDiagnostic, getPath, documentRef, timer, untimer });
      this.states = {};
      this.sent = new Map();
      this.firstCompletedSeen = new Map();
      this.lastUnknownLog = new Map();
      this.declinedUntil = new Map();
      this.started = false;
      this.enabled = false;
    }

    setEnabled(value) {
      this.enabled = value === true;
      if (this.enabled) this.render();
      else this.clearBadges();
    }

    start() {
      if (this.started) return;
      this.started = true;
      this.clock = this.timer(() => { if (this.enabled) { this.render(); this.scan(); } }, 1000);
      // The sidebar is rendered lazily, especially for nested Project conversations.
      if (typeof MutationObserver === "function" && this.documentRef.documentElement) {
        let queued = false;
        this.observer = new MutationObserver((mutations) => {
          if (!this.enabled || queued || mutations.every(({ target }) =>
            target?.closest?.("[" + BADGE + "]"))) return;
          queued = true;
          Promise.resolve().then(() => { queued = false; this.render(); this.scan(); });
        });
        this.observer.observe(this.documentRef.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["data-state", "aria-label", "aria-busy", "class", "data-testid",
            "data-conversation-status", "data-conversation-unread", "data-aih-test-status"]
        });
      }
    }

    stop() {
      this.untimer(this.clock);
      this.observer?.disconnect();
      this.observer = null;
      this.started = false;
      this.clearBadges();
    }

    update(states) {
      this.states = states && typeof states === "object" ? states : {};
      const activeIds = new Set(Object.values(this.states).map((state) => state?.requestId));
      for (const key of this.sent.keys()) if (!activeIds.has(key.split("|")[0])) this.sent.delete(key);
      for (const key of this.firstCompletedSeen.keys()) if (!activeIds.has(key)) this.firstCompletedSeen.delete(key);
      for (const key of this.lastUnknownLog.keys()) if (!activeIds.has(key)) this.lastUnknownLog.delete(key);
      for (const key of this.declinedUntil.keys()) if (!activeIds.has(key.split("|")[0])) this.declinedUntil.delete(key);
      for (const state of Object.values(this.states)) {
        if (!state?.requestId) continue;
        if (state.manualPause === true) this.sent.delete(state.requestId + "|manual-paused");
        else this.sent.delete(state.requestId + "|manual-running");
      }
      if (this.enabled) { this.render(); this.scan(); }
    }

    entries() {
      const result = new Map();
      if (!this.enabled) return result;
      for (const state of Object.values(this.states)) {
        const id = state?.conversationId || getId(state?.path);
        if (state?.site !== this.site || !id || !state?.requestId || !Number.isFinite(state.startedAt)) continue;
        result.set(id, state);
      }
      return result;
    }

    sidebarLinks() {
      const result = new Map();
      for (const link of this.documentRef.querySelectorAll('a[href*="/c/"]')) {
        if (link.closest?.("[data-ai-input-history],[data-ai-input-queue]")) continue;
        const id = conversationIdFromLink(link.getAttribute("href"), this.origin);
        if (!id) continue;
        if (!result.has(id)) result.set(id, []);
        result.get(id).push(link);
      }
      return result;
    }

    hasEntryForPath(path) {
      const id = getId(path);
      return Boolean(id && this.sidebarLinks().has(id));
    }

    getStatusForPath(path) {
      const id = getId(path);
      if (!id) return "unknown";
      const statuses = (this.sidebarLinks().get(id) || []).map((link) => readSidebarStatus(link, this.origin));
      return statuses.includes("paused") ? "paused" : statuses.includes("running") ? "running"
        : statuses.includes("completed") ? "completed" : "unknown";
    }

    clearBadges() {
      this.documentRef.querySelectorAll("[" + BADGE + "]").forEach((badge) => badge.remove());
    }

    render() {
      if (!this.enabled) return this.clearBadges();
      const entries = this.entries();
      const links = this.sidebarLinks();
      const activeId = getId(this.getPath());
      const retained = new Set();
      for (const [id, state] of entries) {
        if (id === activeId) continue;
        for (const link of links.get(id) || []) {
          let badge = link.querySelector("[" + BADGE + "]");
          if (!badge) {
            badge = this.documentRef.createElement("span");
            badge.setAttribute(BADGE, "");
            badge.setAttribute("aria-hidden", "true");
            badge.style.cssText = [
              "display:inline-flex", "align-items:center", "justify-content:center",
              "flex-shrink:0", "min-width:27px", "padding:1px 5px",
              "margin-inline-start:auto", "border-radius:7px", "font-size:10px",
              "font-weight:650", "font-variant-numeric:tabular-nums",
              "line-height:17px", "pointer-events:auto", "cursor:context-menu", "white-space:nowrap",
              "background:rgba(16,163,127,.14)", "color:inherit"
            ].join(";");
            link.appendChild(badge);
            badge.addEventListener("contextmenu", (event) => {
              event.preventDefault();
              event.stopPropagation();
              const current = this.entries().get(id);
              if (!current) return;
              // A page-confirmed choice pause must be resumed by the actual choice,
              // not by manually overriding the page's waiting state.
              if (Number.isFinite(current.pausedAt) && current.manualPause !== true) return;
              this.report(current, current.manualPause === true ? "manual-running" : "manual-paused");
            });
          }
          const frozen = Number.isFinite(state.pausedAt);
          const label = (frozen ? "⏸ " : "") + formatElapsed(elapsedMs(state, this.now()));
          if (badge.textContent !== label) badge.textContent = label;
          badge.title = (frozen ? "计时暂停 " : "正在计时 ")
            + formatElapsed(elapsedMs(state, this.now()))
            + (state.manualPause === true ? " · 右键恢复计时"
              : frozen ? " · 等待会话中的选择操作" : " · 右键暂停计时");
          retained.add(badge);
        }
      }
      this.documentRef.querySelectorAll("[" + BADGE + "]").forEach((badge) => {
        if (!retained.has(badge)) badge.remove();
      });
    }

    async report(state, status) {
      const key = state.requestId + "|" + status;
      if (this.sent.get(key) || this.now() < (this.declinedUntil.get(key) || 0)) return;
      this.sent.set(key, true);
      try {
        const result = await this.onStatus({ requestId: state.requestId, site: state.site, path: state.path, status });
        if (result?.ok === false || (status === "completed" && result?.applied === false)) {
          this.sent.delete(key);
          if (status === "completed") this.declinedUntil.set(key, this.now() + 8_000);
        }
      } catch {
        this.sent.delete(key);
        if (status === "completed") this.declinedUntil.set(key, this.now() + 8_000);
      }
    }

    scan() {
      if (!this.enabled) return;
      const links = this.sidebarLinks();
      const activeId = getId(this.getPath());
      for (const [id, state] of this.entries()) {
        if (id === activeId) continue; // Current transcript owns this request's status.
        const rows = links.get(id);
        if (!rows?.length) continue;
        const statuses = rows.map((link) => readSidebarStatus(link, this.origin));
        const status = statuses.includes("paused") ? "paused"
          : statuses.includes("running") ? "running"
          : statuses.includes("completed") ? "completed" : "unknown";
        if (status === "unknown") {
          const last = this.lastUnknownLog.get(state.requestId);
          if (last == null || this.now() - last >= 60_000) {
            this.lastUnknownLog.set(state.requestId, this.now());
            try {
              this.onDiagnostic({
                stage: "timing-sidebar-status-unknown", source: "sidebar",
                site: state.site, conversationId: id, requestId: state.requestId,
                reason: "no-recognized-sidebar-status-marker",
                sidebarLinkCount: rows.length,
                sidebarMarkerCount: rows.reduce((count, link) => count +
                  (statusScopeForLink(link, this.origin)?.querySelectorAll?.(
                    '[data-testid],[aria-label],[title],[data-state]'
                  )?.length || 0), 0)
              });
            } catch {}
          }
        } else this.lastUnknownLog.delete(state.requestId);
        if (status !== "completed") this.firstCompletedSeen.delete(state.requestId);
        if (!Number.isFinite(state.pausedAt)) this.sent.delete(state.requestId + "|paused");
        else this.sent.delete(state.requestId + "|running");
        if (status === "paused" && !Number.isFinite(state.pausedAt)) this.report(state, "paused");
        else if (status === "running" && Number.isFinite(state.pausedAt) && state.manualPause !== true)
          this.report(state, "running");
        else if (status === "completed" && state.sidebarUnreadCleared === true) {
          const seen = this.firstCompletedSeen.get(state.requestId);
          if (seen == null) this.firstCompletedSeen.set(state.requestId, this.now());
          else if (this.now() - seen >= 1000) this.report(state, "completed");
        }
        if (status !== "completed" && state.sidebarUnreadCleared === false) {
          this.report(state, "unread-cleared");
        }
      }
    }
  }

  namespace.SidebarTiming = SidebarTiming;
  namespace.sidebarTimingModel = { conversationIdFromLink, statusScopeForLink,
    readSidebarStatus, elapsedMs, formatElapsed };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
