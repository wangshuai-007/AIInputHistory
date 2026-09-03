(function initializeClearConfirmation(namespace) {
  "use strict";

  class ClearConfirmation {
    constructor(root, onConfirm) {
      this.root = root;
      this.onConfirm = onConfirm;
      this.dialog = root.querySelector(".clear-dialog");
      this.error = root.querySelector(".confirm-error");
      this.acceptButton = root.querySelector(".confirm-accept");
      root.querySelector(".confirm-cancel").addEventListener("click", () => this.close());
      this.acceptButton.addEventListener("click", () => this.confirm());
      this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.close(); });
    }

    /** Opens the modal and moves focus to the safe cancel action. */
    open() {
      this.error.classList.add("hidden");
      this.error.textContent = "";
      if (!this.dialog.open) this.dialog.showModal();
      this.root.querySelector(".confirm-cancel").focus();
    }

    /** Closes the modal without running the destructive action. */
    close() {
      if (this.dialog.open) this.dialog.close();
    }

    /** Reports whether the modal is currently open. */
    isOpen() {
      return this.dialog.open;
    }

    /** Runs the destructive action once and keeps failures visible for retry. */
    async confirm() {
      this.acceptButton.disabled = true;
      try {
        await this.onConfirm();
        this.close();
      } catch (error) {
        this.error.textContent = "清除失败，请重试。";
        this.error.classList.remove("hidden");
        console.warn("[AI 输入历史] 清除历史失败", error);
      } finally {
        this.acceptButton.disabled = false;
      }
    }
  }

  namespace.ClearConfirmation = ClearConfirmation;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
