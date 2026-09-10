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
    update(elapsedMs) {
      this.active = elapsedMs !== null;
      this.panel.launcher.classList.toggle("timing-active", this.active);
      if (this.active) {
        this.panel.launcher.classList.remove("aih-saved");
        const seconds = Math.floor(elapsedMs / 1000);
        if (this.lastSeconds === seconds) return;
        this.lastSeconds = seconds;
        this.label.textContent = `${seconds}s`;
        this.panel.launcher.setAttribute("aria-label", namespace.i18n.t("timing.running", { seconds }));
      } else {
        this.lastSeconds = null;
        this.label.textContent = "";
        this.panel.launcher.setAttribute("aria-label", namespace.i18n.t("panel.launcherAria"));
      }
    }
  }

  namespace.RequestTimingView = RequestTimingView;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
