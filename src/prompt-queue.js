(function initializePromptQueue(namespace) {
  "use strict";

  const CHATGPT_SITES = /^(chatgpt\.com|chat\.openai\.com)$/i;
  const QUEUE_LIMIT = 20;
  const DISPATCH_TIMEOUT_MS = 10_000;
  const STALE_REQUEST_MS = 2 * 60 * 1000;

  function supportedSite(site = location.hostname) {
    return CHATGPT_SITES.test(site) || namespace.SiteProfiles?.forSite(site)?.id === "chatgpt";
  }

  function currentQueueKey() {
    return `${location.hostname}|${location.pathname}`;
  }

  function canAdoptQueueKey(fromKey, toKey) {
    const fromPath = String(fromKey || "").split("|").slice(1).join("|");
    const toPath = String(toKey || "").split("|").slice(1).join("|");
    return Boolean(fromPath && toPath && !/\/c\//.test(fromPath) && /\/c\//.test(toPath));
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function normalizePromptText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function userTurns() {
    const scope = document.querySelector("main") || document;
    const nodes = [...scope.querySelectorAll('[data-message-author-role="user"]')];
    return nodes.map((node, index) => {
      const turn = node.closest('article,[data-testid^="conversation-turn-"]') || node;
      const key = node.getAttribute("data-message-id") || turn.getAttribute?.("data-testid") || `user-index:${index}`;
      return { key, text: normalizePromptText(node.textContent) };
    });
  }

  function queueStyle() {
    return `:host{all:initial;position:fixed;z-index:2147483645;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#202123}
      .queue{box-sizing:border-box;min-width:320px;max-width:720px;border:1px solid rgba(16,163,127,.22);border-radius:16px;background:rgba(255,255,255,.96);box-shadow:0 12px 36px rgba(0,0,0,.15);backdrop-filter:blur(14px);overflow:hidden;pointer-events:auto}
      .head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px 7px;font-size:12px;font-weight:650;color:#087c64;border-bottom:1px solid rgba(16,163,127,.12)}
      .count{font-variant-numeric:tabular-nums;color:#667085;font-weight:500}.items{max-height:260px;overflow:auto;padding:6px}
      .item{display:grid;grid-template-columns:28px minmax(0,1fr) auto;gap:8px;align-items:start;padding:8px;border-radius:11px}.item+.item{margin-top:2px}.item:hover{background:rgba(16,163,127,.055)}
      .number{display:grid;place-items:center;width:24px;height:24px;border-radius:8px;background:rgba(16,163,127,.10);color:#087c64;font-size:11px;font-weight:700}.text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.45;max-height:52px;overflow:hidden;padding-top:3px}
      .actions{display:flex;gap:2px;flex-wrap:wrap;justify-content:flex-end}.action{border:0;background:transparent;color:#667085;border-radius:7px;padding:5px 7px;cursor:pointer;font:inherit;font-size:11px}.action:hover{background:rgba(0,0,0,.06);color:#202123}.action:disabled{opacity:.45;cursor:default}.action.send-now{color:#087c64;font-weight:650}.action.remove:hover{color:#b42318;background:#fff1f0}.status.failed{color:#b42318}
      .editing{grid-template-columns:28px minmax(0,1fr)}.editor{grid-column:2/-1;display:grid;gap:7px}.editor textarea{box-sizing:border-box;width:100%;min-height:72px;max-height:180px;resize:vertical;border:1px solid rgba(16,163,127,.3);border-radius:10px;padding:8px 10px;background:#fff;color:inherit;font:12px/1.45 inherit;outline:none}.editor textarea:focus{border-color:#10a37f;box-shadow:0 0 0 2px rgba(16,163,127,.12)}
      .editor-actions{display:flex;justify-content:flex-end;gap:6px}.save{background:#10a37f;color:#fff}.save:hover{background:#0d8f70;color:#fff}.status{font-size:10px;color:#087c64;padding-top:4px}.hidden{display:none!important}
      @media(prefers-color-scheme:dark){:host{color:#ececec}.queue{background:rgba(33,33,33,.96);border-color:rgba(52,211,153,.22);box-shadow:0 12px 36px rgba(0,0,0,.45)}.head{color:#6ee7b7;border-bottom-color:rgba(52,211,153,.12)}.count,.action{color:#a6a6a6}.item:hover{background:rgba(52,211,153,.06)}.number{background:rgba(52,211,153,.12);color:#6ee7b7}.action:hover{background:rgba(255,255,255,.08);color:#fff}.editor textarea{background:#2f2f2f;color:#ececec;border-color:rgba(52,211,153,.28)}.status{color:#6ee7b7}}
    `;
  }

  class PromptQueue {
    constructor({ store, adapter, getInput, isRequestActive = () => false, getRequestStartedAt = () => 0, dispatchTimeoutMs = DISPATCH_TIMEOUT_MS }) {
      Object.assign(this, { store, adapter, getInput, isRequestActive, getRequestStartedAt, dispatchTimeoutMs });
      this.enabled = supportedSite();
      this.key = currentQueueKey();
      this.items = [];
      this.editingId = "";
      this.dispatchingId = "";
      this.dispatchRecordedId = "";
      this.dispatchText = "";
      this.dispatchBaselineUsers = [];
      this.dispatchAttemptAt = 0;
      this.dispatchStartedAt = 0;
      this.failedIds = new Set();
      this.autoDispatching = false;
      this.directClickUntil = 0;
      this.directSubmitUntil = 0;
      this.sawPageBusy = false;
      this.drainTimer = null;
      this.host = null;
    }
    async init() {
      if (!this.enabled) return;
      this.items = await this.store.getPromptQueue(this.key);
      this.ensureHost();
      this.render();
      this.observer = new MutationObserver(() => {
        this.syncConversationKey().catch(() => {});
        this.scheduleDrain(0);
        this.reposition();
      });
      this.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "data-is-streaming", "aria-label", "data-testid"] });
      this.storageListener = (changes, areaName) => {
        if (areaName === "local" && changes[namespace.STORAGE_KEYS.promptQueue]) this.refresh().catch(() => {});
      };
      chrome.storage.onChanged?.addListener(this.storageListener);
      window.addEventListener("resize", () => this.reposition());
      window.addEventListener("scroll", () => this.reposition(), true);
      this.scheduleDrain(0);
    }

    ensureHost() {
      if (this.host?.isConnected) return;
      this.host = document.createElement("div");
      this.host.dataset.aiInputQueue = "root";
      this.shadow = this.host.attachShadow({ mode: globalThis.__AIH_TEST_OPEN_SHADOW === true ? "open" : "closed" });
      this.shadow.innerHTML = `<style>${queueStyle()}</style><section class="queue hidden"><div class="head"><span class="title"></span><span class="count"></span></div><div class="items"></div></section>`;
      this.shadow.addEventListener("click", (event) => this.handleClick(event));
      document.documentElement.appendChild(this.host);
    }

    async refresh() {
      if (!this.enabled) return;
      await this.syncConversationKey();
      this.items = await this.store.getPromptQueue(this.key);
      if (this.dispatchingId && !this.items.some((item) => item.id === this.dispatchingId)) this.resetDispatchState();
      this.render();
      this.scheduleDrain(0);
    }

    render() {
      if (!this.shadow) return;
      const section = this.shadow.querySelector(".queue");
      section.classList.toggle("hidden", this.items.length === 0);
      this.shadow.querySelector(".title").textContent = namespace.i18n.t("queue.title");
      this.shadow.querySelector(".count").textContent = namespace.i18n.t("queue.count", { count: this.items.length });
      this.shadow.querySelector(".items").innerHTML = this.items.map((item, index) => this.itemMarkup(item, index)).join("");
      this.reposition();
      if (this.editingId) this.shadow.querySelector(`[data-editor="${CSS.escape(this.editingId)}"]`)?.focus();
    }
    itemMarkup(item, index) {
      const editing = this.editingId === item.id;
      const dispatching = this.dispatchingId === item.id;
      if (editing) {
        return `<div class="item editing" data-id="${escapeHtml(item.id)}"><span class="number">${index + 1}</span><div class="editor"><textarea data-editor="${escapeHtml(item.id)}">${escapeHtml(item.text)}</textarea><div class="editor-actions"><button class="action" data-action="cancel-edit" data-id="${escapeHtml(item.id)}">${escapeHtml(namespace.i18n.t("queue.cancel"))}</button><button class="action save" data-action="save" data-id="${escapeHtml(item.id)}">${escapeHtml(namespace.i18n.t("queue.save"))}</button></div></div></div>`;
      }
      const failed = this.failedIds.has(item.id);
      const status = dispatching
        ? `<div class="status">${escapeHtml(namespace.i18n.t("queue.sending"))}</div>`
        : failed ? `<div class="status failed">${escapeHtml(namespace.i18n.t("queue.failed"))}</div>` : "";
      const disabled = dispatching ? "disabled" : "";
      const sendDisabled = this.dispatchingId ? "disabled" : "";
      return `<div class="item" data-id="${escapeHtml(item.id)}"><span class="number">${index + 1}</span><div><div class="text">${escapeHtml(item.text)}</div>${status}</div><div class="actions"><button class="action send-now" data-action="send-now" data-id="${escapeHtml(item.id)}" ${sendDisabled}>${escapeHtml(namespace.i18n.t("queue.sendNow"))}</button><button class="action" data-action="edit" data-id="${escapeHtml(item.id)}" ${disabled}>${escapeHtml(namespace.i18n.t("queue.edit"))}</button><button class="action remove" data-action="remove" data-id="${escapeHtml(item.id)}" ${disabled}>${escapeHtml(namespace.i18n.t("queue.remove"))}</button></div></div>`;
    }

    async handleClick(event) {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const id = button.dataset.id;
      const action = button.dataset.action;
      if (action === "send-now") {
        await this.sendNow(id);
        return;
      }
      if (action === "edit") {
        this.editingId = id;
        this.render();
        return;
      }
      if (action === "cancel-edit") {
        this.editingId = "";
        this.render();
        return;
      }
      if (action === "save") {
        const value = this.shadow.querySelector(`[data-editor="${CSS.escape(id)}"]`)?.value || "";
        if (!value.trim()) return;
        await this.store.updatePromptQueueItem(this.key, id, value);
        this.failedIds.delete(id);
        this.editingId = "";
        await this.refresh();
        return;
      }
      if (action === "remove") {
        this.failedIds.delete(id);
        if (this.dispatchingId === id) this.resetDispatchState();
        await this.store.removePromptQueueItem(this.key, id);
        if (this.editingId === id) this.editingId = "";
        await this.refresh();
      }
    }

    async sendNow(id) {
      await this.syncConversationKey();
      const item = this.items.find((entry) => entry.id === id);
      if (!item) return false;
      const input = this.getInput?.() || this.adapter.findComposer(document, this.shadow);
      if (!input?.isConnected || this.adapter.getText(input).trim()) return false;
      this.failedIds.delete(id);
      this.resetDispatchState();
      this.dispatchingId = id;
      this.dispatchRecordedId = "";
      this.dispatchText = item.text;
      this.dispatchBaselineUsers = userTurns();
      this.dispatchAttemptAt = 0;
      this.dispatchStartedAt = Date.now();
      this.render();
      this.adapter.setText(input, item.text);
      this.continueDispatch(input, id);
      return true;
    }

    resetDispatchState() {
      clearTimeout(this.dispatchConfirmTimer);
      clearTimeout(this.dispatchRetryTimer);
      this.dispatchingId = "";
      this.dispatchRecordedId = "";
      this.dispatchText = "";
      this.dispatchBaselineUsers = [];
      this.dispatchAttemptAt = 0;
      this.dispatchStartedAt = 0;
      this.autoDispatching = false;
    }

    pageState() {
      try { return namespace.requestTimingModel?.sampleChatGPT?.() || null; }
      catch { return null; }
    }

    requestLooksStale(state) {
      if (!this.isRequestActive() || state?.busy === true) return false;
      const startedAt = Number(this.getRequestStartedAt?.());
      const latestReply = Array.isArray(state?.replies) ? state.replies.at(-1) : null;
      return Number.isFinite(startedAt) && startedAt > 0
        && Date.now() - startedAt >= STALE_REQUEST_MS
        && latestReply?.complete === true;
    }

    isBusy() {
      const state = this.pageState();
      if (state?.busy === true) {
        this.sawPageBusy = true;
        return true;
      }
      if (this.requestLooksStale(state)) return false;
      return this.isRequestActive();
    }

    canDrain() {
      const state = this.pageState();
      if (state?.busy === true) {
        this.sawPageBusy = true;
        return false;
      }
      if (!this.isRequestActive() || this.requestLooksStale(state)) return true;
      const explicitComplete = this.sawPageBusy && state?.replies?.some((reply) => reply?.complete === true);
      return explicitComplete === true;
    }

    shouldQueue() {
      return this.enabled && !this.autoDispatching && this.isBusy();
    }
    interceptKeydown(event, input) {
      if (!input || event.key !== "Enter" || event.isComposing || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return false;
      const text = this.adapter.getText(input);
      if (!text.trim()) return false;
      if (!this.shouldQueue()) {
        this.directSubmitUntil = Date.now() + 400;
        return false;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      this.enqueueFromInput(input).catch((error) => console.warn("[AI 输入历史] 加入排队失败", error));
      return true;
    }

    interceptSubmit(event, input) {
      if (!input || !event.target?.contains?.(input)) return false;
      if (this.directSubmitUntil > Date.now()) return false;
      if (!this.shouldQueue()) return false;
      const text = this.adapter.getText(input);
      if (!text.trim()) return false;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.enqueueFromInput(input).catch((error) => console.warn("[AI 输入历史] 加入排队失败", error));
      return true;
    }

    interceptSendControl(event, input) {
      if (this.autoDispatching || !input) return false;
      if (event.type === "click" && this.suppressSendClickUntil > Date.now()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
      if (event.type === "click" && this.directClickUntil > Date.now()) return false;
      if (event.button != null && event.button !== 0) return false;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      const button = path.map((target) => namespace.sendDetection?.getSendButton?.(target, input)).find(Boolean);
      if (!button) return false;
      const text = this.adapter.getText(input);
      if (!text.trim()) return false;
      if (!this.shouldQueue()) {
        if (event.type === "pointerdown") {
          this.directClickUntil = Date.now() + 600;
          this.directSubmitUntil = Date.now() + 600;
        }
        return false;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type === "pointerdown") this.suppressSendClickUntil = Date.now() + 600;
      this.enqueueFromInput(input).catch((error) => console.warn("[AI 输入历史] 加入排队失败", error));
      return true;
    }

    async enqueueFromInput(input) {
      await this.syncConversationKey();
      const text = this.adapter.getText(input);
      if (!text.trim()) return false;
      this.sawPageBusy = this.pageState()?.busy === true;
      const item = await this.store.enqueuePrompt(this.key, text);
      if (!item) return false;
      this.adapter.setText(input, "");
      this.items = await this.store.getPromptQueue(this.key);
      this.render();
      return true;
    }

    scheduleDrain(delay = 80) {
      if (!this.enabled || !this.items.length || this.editingId) return;
      clearTimeout(this.drainTimer);
      this.drainTimer = setTimeout(() => this.tryDrain().catch((error) => console.warn("[AI 输入历史] 排队发送失败", error)), delay);
    }
    async tryDrain() {
      if (!this.items.length || this.editingId || this.dispatchingId || !this.canDrain()) return;
      await this.syncConversationKey();
      if (!this.items.length || !this.canDrain()) return;
      const input = this.getInput?.() || this.adapter.findComposer(document, this.shadow);
      if (!input?.isConnected) return;
      if (this.adapter.getText(input).trim()) return;
      const item = this.items.find((entry) => !this.failedIds.has(entry.id));
      if (!item) return;
      this.dispatchingId = item.id;
      this.dispatchRecordedId = "";
      this.dispatchText = item.text;
      this.dispatchBaselineUsers = userTurns();
      this.dispatchAttemptAt = 0;
      this.dispatchStartedAt = Date.now();
      this.render();
      this.adapter.setText(input, item.text);
      this.continueDispatch(input, item.id);
    }

    continueDispatch(input, itemId) {
      if (this.dispatchingId !== itemId) return;
      if (this.dispatchStartedAt && Date.now() - this.dispatchStartedAt >= this.dispatchTimeoutMs) {
        this.markDispatchFailed(input, itemId);
        return;
      }
      if (this.hasAcceptedUserTurn()) {
        this.finalizeDispatch(itemId).catch((error) => console.warn("[AI 输入历史] 确认自动发送失败", error));
        return;
      }
      const state = this.pageState();
      if (state?.busy === true) {
        this.sawPageBusy = true;
        this.scheduleDispatchVerification(input, itemId, 150);
        return;
      }
      const item = this.items.find((entry) => entry.id === itemId);
      if (!item) return;
      if (normalizePromptText(this.adapter.getText(input)) !== normalizePromptText(item.text)) this.adapter.setText(input, item.text);
      const button = this.findSendButton(input);
      if (!button) {
        this.scheduleDispatchVerification(input, itemId, 120);
        return;
      }
      this.dispatchAttemptAt = Date.now();
      this.autoDispatching = true;
      try { button.click(); }
      finally {
        queueMicrotask(() => {
          this.autoDispatching = false;
          this.verifyDispatch(input, itemId);
        });
      }
    }

    verifyDispatch(input, itemId) {
      if (this.dispatchingId !== itemId) return;
      if (this.dispatchStartedAt && Date.now() - this.dispatchStartedAt >= this.dispatchTimeoutMs) {
        this.markDispatchFailed(input, itemId);
        return;
      }
      if (this.hasAcceptedUserTurn()) {
        this.finalizeDispatch(itemId).catch((error) => console.warn("[AI 输入历史] 确认自动发送失败", error));
        return;
      }
      const state = this.pageState();
      if (state?.busy === true) this.sawPageBusy = true;
      const elapsed = Date.now() - this.dispatchAttemptAt;
      if (state?.busy === true || elapsed < 1200) {
        this.scheduleDispatchVerification(input, itemId, 150);
        return;
      }
      this.continueDispatch(input, itemId);
    }

    scheduleDispatchVerification(input, itemId, delay) {
      clearTimeout(this.dispatchConfirmTimer);
      this.dispatchConfirmTimer = setTimeout(() => this.verifyDispatch(input, itemId), delay);
    }

    markDispatchFailed(input, itemId) {
      if (this.dispatchingId !== itemId) return;
      const currentText = normalizePromptText(this.adapter.getText(input));
      if (currentText && currentText === normalizePromptText(this.dispatchText)) this.adapter.setText(input, "");
      this.failedIds.add(itemId);
      this.resetDispatchState();
      this.sawPageBusy = false;
      this.render();
      this.scheduleDrain(0);
    }

    hasAcceptedUserTurn() {
      if (!this.dispatchingId || !this.dispatchText) return false;
      const expected = normalizePromptText(this.dispatchText);
      const baseline = this.dispatchBaselineUsers || [];
      const baselineSet = new Set(baseline.map((turn) => `${turn.key}\u0000${turn.text}`));
      const current = userTurns();
      if (current.length > baseline.length && current.slice(baseline.length).some((turn) => turn.text === expected)) return true;
      return current.some((turn) => turn.text === expected && !baselineSet.has(`${turn.key}\u0000${turn.text}`));
    }

    findSendButton(input) {
      const selector = [
        "#composer-submit-button",
        "button[data-testid='send-button']",
        "button[data-testid*='send-button']",
        "button.composer-submit-btn",
        "button[aria-label='Send prompt']",
        "button[aria-label='Send message']",
        "button[aria-label='发送提示词']",
        "button[aria-label='发送消息']"
      ].join(",");
      const candidates = [...document.querySelectorAll(selector)]
        .filter((button) => button.getClientRects().length > 0 && !button.matches("[disabled],[aria-disabled='true']"));
      return candidates.map((target) => namespace.sendDetection?.getSendButton?.(target, input)).find(Boolean) || null;
    }

    async finalizeDispatch(itemId) {
      if (!itemId || this.dispatchingId !== itemId) return false;
      this.failedIds.delete(itemId);
      this.resetDispatchState();
      this.sawPageBusy = false;
      await this.store.removePromptQueueItem(this.key, itemId);
      this.items = await this.store.getPromptQueue(this.key);
      this.render();
      this.scheduleDrain(0);
      return true;
    }

    async confirmRecordedSend(text) {
      if (!this.dispatchingId) return false;
      const item = this.items.find((entry) => entry.id === this.dispatchingId);
      if (!item || item.text.trim() !== String(text || "").trim()) return false;
      this.dispatchRecordedId = item.id;
      return true;
    }

    suppressAutoDispatchRecord() {
      return Boolean(this.autoDispatching && this.dispatchingId && this.dispatchRecordedId === this.dispatchingId);
    }

    onRequestFinished() {
      this.scheduleDrain(0);
    }
    async syncConversationKey() {
      const nextKey = currentQueueKey();
      if (nextKey === this.key) return;
      if (canAdoptQueueKey(this.key, nextKey)) {
        this.items = await this.store.movePromptQueue(this.key, nextKey);
      } else {
        this.items = await this.store.getPromptQueue(nextKey);
      }
      this.key = nextKey;
      this.editingId = "";
      this.failedIds.clear();
      this.resetDispatchState();
      this.sawPageBusy = false;
      this.render();
    }

    reposition() {
      if (!this.host || !this.items.length) return;
      const input = this.getInput?.() || this.adapter.findComposer(document, this.shadow);
      if (!input?.isConnected) return;
      const anchor = input.closest("form") || input;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(720, Math.max(320, rect.width));
      this.host.style.width = `${width}px`;
      this.host.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`;
      const section = this.shadow.querySelector(".queue");
      const height = section?.getBoundingClientRect().height || 120;
      const above = rect.top - height - 8;
      this.host.style.top = `${above >= 8 ? above : Math.min(window.innerHeight - height - 8, rect.bottom + 8)}px`;
    }
  }

  namespace.PromptQueue = PromptQueue;
  namespace.promptQueueModel = { QUEUE_LIMIT, canAdoptQueueKey, currentQueueKey, supportedSite };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
