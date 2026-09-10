(function initializeSendDetector(namespace) {
  "use strict";

  const SEND_PATTERN = /(^|\b)(send|submit|send message|send-message)(\b|$)|发送|提交|发送消息/i;
  const EXCLUDE_PATTERN = /stop|cancel|abort|停止|取消/i;

  function didComposerClear(before, after, connected = true) {
    return Boolean(connected && String(before || "").trim()) && !String(after || "").trim();
  }

  function getSendButton(target, input) {
    const button = target instanceof Element ? target.closest("button,[role='button'],[type='submit']") : null;
    if (!button || button.matches("[disabled],[aria-disabled='true']")) return null;
    const signals = [
      button.textContent,
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.getAttribute("data-testid"),
      typeof button.className === "string" ? button.className : "",
      button.getAttribute("name"),
      button.getAttribute("type")
    ].filter(Boolean).join(" ");
    const profileMatch = namespace.SiteProfiles.matchesSendButton(button, location.hostname);
    if ((!SEND_PATTERN.test(signals) && !profileMatch) || EXCLUDE_PATTERN.test(signals)) return null;
    if (input.closest("form")?.contains(button)) return button;
    const inputRect = input.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const horizontalGap = Math.max(0, Math.max(inputRect.left - buttonRect.right, buttonRect.left - inputRect.right));
    const verticalGap = Math.max(0, Math.max(inputRect.top - buttonRect.bottom, buttonRect.top - inputRect.bottom));
    return horizontalGap <= 240 && verticalGap <= 160 ? button : null;
  }

  class SendDetector {
    constructor(adapter, onSend, capture = () => null, onRequest = () => null) {
      this.adapter = adapter;
      this.onSend = onSend;
      this.lastEmission = null;
      this.pendingEnter = null;
      this.capture = capture;
      this.onRequest = onRequest;
    }

    watchEnter(event, input, context) {
      if (event.key !== "Enter" || event.isComposing || event.repeat || !input || !context) return;
      const text = this.adapter.getText(input);
      if (!text.trim()) return;
      this.cancelEnter();
      const candidate = { input, text, context, done: false, metadata: { sentAt: Date.now(), timing: this.capture(context), promptText: text } };
      candidate.onInput = (inputEvent) => {
        if (["insertLineBreak", "insertParagraph"].includes(inputEvent.inputType)
          || (this.adapter.getText(input).trim() && this.adapter.getText(input) !== text)) this.cancelEnter();
      };
      input.addEventListener?.("input", candidate.onInput);
      this.pendingEnter = candidate;
      [40, 140, 400, 900].forEach((delay, index, delays) => {
        setTimeout(() => {
          if (candidate.done) return;
          const connected = input.isConnected;
          const current = connected ? this.adapter.getText(input) : "";
          if (!connected) {
            this.cancelEnter();
          } else if (didComposerClear(candidate.text, current, connected)) {
            this.cancelEnter();
            this.emit(candidate.text, candidate.context, "keyboard", candidate.metadata);
          } else if (current !== candidate.text) {
            this.cancelEnter();
          } else if (index === delays.length - 1) {
            this.cancelEnter();
            if (namespace.SiteProfiles.isSendShortcut(event, context.site)) this.emit(candidate.text, candidate.context, "keyboard-attempt", candidate.metadata);
          }
        }, delay);
      });
    }

    /** Releases a pending Enter observation after another edit or send event. */
    cancelEnter() {
      if (!this.pendingEnter) return;
      this.pendingEnter.done = true;
      this.pendingEnter.input.removeEventListener?.("input", this.pendingEnter.onInput);
      this.pendingEnter = null;
    }

    handleSubmit(event, input, context) {
      if (!input || !context || !event.target.contains(input)) return;
      const metadata = { sentAt: Date.now(), timing: this.capture(context), promptText: this.adapter.getText(input) };
      this.onRequest(context, metadata);
      this.emitCurrent(input, context, "form", metadata);
    }

    handlePointerDown(event, input, context) {
      const nonPrimaryPointer = event.type?.startsWith("pointer") && event.isPrimary === false;
      if (!input || !context || (event.button != null && event.button !== 0) || nonPrimaryPointer) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      const button = path.map((target) => getSendButton(target, input)).find(Boolean);
      if (!button) return;
      const metadata = { sentAt: Date.now(), timing: this.capture(context), promptText: this.adapter.getText(input) };
      this.onRequest(context, metadata);
      this.emitCurrent(input, context, "button", metadata);
    }

    emitCurrent(input, context, source, metadata = { sentAt: Date.now(), timing: this.capture(context), promptText: this.adapter.getText(input) }) {
      const text = this.adapter.getText(input);
      if (text.trim()) this.emit(text, context, source, metadata);
    }

    emit(text, context, source, metadata) {
      this.cancelEnter();
      const fingerprint = `${context.fieldKey}|${text}`;
      const now = Date.now();
      if (this.lastEmission?.fingerprint === fingerprint && now - this.lastEmission.at < 1500) return;
      this.lastEmission = { fingerprint, at: now };
      this.onSend(text, context, source, metadata);
    }
  }

  namespace.SendDetector = SendDetector;
  namespace.sendDetection = { didComposerClear, getSendButton };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
