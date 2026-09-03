(function initializeHistoryNavigator(namespace) {
  "use strict";

  class HistoryNavigator {
    constructor(store, adapter) {
      this.store = store;
      this.adapter = adapter;
      this.reset();
    }

    reset() {
      this.entries = null;
      this.index = -1;
      this.original = "";
      this.applying = false;
      this.loadRevision = (this.loadRevision || 0) + 1;
    }

    isApplying() {
      return this.applying;
    }

    /** Moves backward or forward through site history and restores the original text at the newest edge. */
    async move(direction, input, context) {
      if (!input || !context || !["up", "down"].includes(direction)) return false;
      if (!this.entries) await this.load(input, context);
      if (!this.entries?.length) return false;

      if (direction === "up") {
        this.index = Math.min(this.entries.length - 1, this.index + 1);
        this.apply(input, this.entries[this.index].text);
        return true;
      }
      if (this.index <= 0) {
        this.index = -1;
        this.apply(input, this.original);
        return true;
      }
      this.index -= 1;
      this.apply(input, this.entries[this.index].text);
      return true;
    }

    async load(input, context) {
      const revision = this.loadRevision;
      const original = this.adapter.getText(input);
      const entries = await this.store.getHistory("", false, context.site);
      if (revision !== this.loadRevision) return;
      this.original = original;
      this.entries = entries.filter((entry) => !isCurrentComposition(entry, context));
    }

    apply(input, text) {
      this.applying = true;
      try {
        this.adapter.setText(input, text);
      } finally {
        this.applying = false;
      }
    }
  }

  function isCurrentComposition(entry, context) {
    if (entry.kind === "draft" && entry.fieldKey === context.fieldKey) return true;
    return entry.kind === "snapshot" && entry.sessionId && entry.sessionId === context.sessionId;
  }

  namespace.HistoryNavigator = HistoryNavigator;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
