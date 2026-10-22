(function initializeTimingView(namespace) {
  "use strict";

  /** Renders the transient request clock without replacing the draggable launcher button. */
  class RequestTimingView {
    constructor(panel) {
      this.panel = panel;
      this.active = false;
      this.label = document.createElement("span");
      this.label.className = "request-clock";
      this.label.setAttribute("aria-hidden", "true");
      panel.launcher.appendChild(this.label);
    }

    /** Shows elapsed seconds or restores the history icon when observation ends. */
    update(elapsedMs, paused = false) {
      this.active = elapsedMs !== null;
      this.panel.launcher.classList.toggle("timing-active", this.active);
      this.panel.launcher.classList.toggle("timing-paused", this.active && paused);
      this.panel.syncLauncherMenu?.();
      if (this.active) {
        this.panel.launcher.classList.remove("aih-saved");
        const seconds = Math.floor(elapsedMs / 1000);
        if (this.lastSeconds === seconds && this.wasPaused === paused) return;
        this.lastSeconds = seconds;
        this.wasPaused = paused;
        this.label.textContent = (paused ? "⏸ " : "") + `${seconds}s`;
        this.panel.launcher.setAttribute("aria-label", namespace.i18n.t(paused ? "timing.paused" : "timing.running", { seconds }));
      } else {
        this.lastSeconds = null;
        this.wasPaused = false;
        this.label.textContent = "";
        this.panel.launcher.setAttribute("aria-label", namespace.i18n.t("panel.launcherAria"));
      }
    }
  }

  namespace.RequestTimingView = RequestTimingView;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
