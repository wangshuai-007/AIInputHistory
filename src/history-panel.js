(function initializeHistoryPanel(namespace) {
  "use strict";

  const { clampPosition, composerRect, enterIcon, escapeHtml, formatSavedTime, renderEntries } = namespace.historyPanelUtils;

  const STYLE = namespace.historyPanelStyle;

  class HistoryPanel {
    constructor(store, onSelect, onClear) {
      this.store = store;
      this.onSelect = onSelect;
      this.onClear = onClear;
      this.items = [];
      this.refreshRevision = 0;
      this.openRevision = 0;
      this.pinning = new Set();
      this.selectedIndex = 0;
      this.sendOnly = false;
      this.pinnedOnly = false;
      this.site = location.hostname;
      this.selectedSite = this.site;
      this.launcherEnabled = true;
      this.savedPositions = {};
      this.manualPositions = { launcher: false, panel: false };
      this.host = document.createElement("div");
      this.host.dataset.aiInputHistory = "root";
      this.shadow = this.host.attachShadow({ mode: globalThis.__AIH_TEST_OPEN_SHADOW === true ? "open" : "closed" });
      this.shadow.innerHTML = `<style>${STYLE}</style>${this.markup()}`;
      namespace.i18n.localize(this.shadow);
      document.documentElement.appendChild(this.host);
      namespace.observePageTheme(this.host);
      this.launcher = this.shadow.querySelector(".launcher");
      this.panel = this.shadow.querySelector(".panel");
      this.search = this.shadow.querySelector(".search");
      this.siteFilter = new namespace.SiteFilter(this.shadow.querySelector(".site-filter-host"), this.site, (site) => {
        this.selectedSite = site;
        this.refresh();
      }, (expanded) => this.panel.classList.toggle("site-menu-open", expanded));
      this.list = this.shadow.querySelector(".list");
      this.savedStatus = this.shadow.querySelector(".saved-status");
      this.launcherTooltip = this.shadow.querySelector(".launcher-tooltip");
      this.timingView = new namespace.RequestTimingView(this);
      this.clearConfirmation = new namespace.ClearConfirmation(this.shadow, () => this.clearHistory());
      this.bindEvents();
      this.positionsReady = this.loadPositions().catch((error) => this.reportError(error));
      this.loadLastSavedTime().catch((error) => console.warn("[AI 输入历史] 读取上次自动保存时间失败", error));
    }

    markup() {
      return `<button class="launcher hidden" type="button" data-i18n-aria-label="panel.launcherAria" aria-label="打开输入历史；长按移动；右键隐藏" aria-describedby="aih-last-saved">
        <span class="launcher-symbol launcher-history"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h11M4 12h11M4 17h7M18 15v6m-3-3h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></span>
        <span class="launcher-symbol launcher-save"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 4h11l3 3v13H5V4Zm3 0v6h8V4M8 20v-6h8v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <span class="saved-status sr-only" aria-live="polite"></span>
        <span class="launcher-tooltip" id="aih-last-saved" role="tooltip" data-i18n="panel.neverSaved">尚未自动保存</span>
      </button>
      <section class="panel hidden" role="dialog" data-i18n-aria-label="panel.aria" aria-label="输入历史">
        <header class="head"><div class="title-row"><div><span class="title" data-i18n="panel.title">输入历史</span><span class="hint" data-i18n="panel.dragHint">拖动标题移动</span></div><div class="actions">
          <button class="icon-button clear" type="button" data-i18n-aria-label="panel.clearAria" data-i18n-title="panel.clearAria" aria-label="一键清除全部历史" title="一键清除全部历史"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button class="icon-button close" type="button" data-i18n-aria-label="panel.close" data-i18n-title="panel.close" aria-label="关闭" title="关闭"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        </div></div>
        <input class="search" type="search" data-i18n-placeholder="panel.searchPlaceholder" data-i18n-aria-label="panel.searchAria" placeholder="搜索本地历史…" aria-label="搜索输入历史">
        <div class="filter-row"><div class="site-filter-host"></div>
        <div class="filters"><button class="filter active" data-filter="all" type="button" data-i18n="panel.all">全部</button><button class="filter" data-filter="send" type="button">${enterIcon()}<span data-i18n="panel.send">发送</span></button><button class="filter" data-filter="pinned" type="button" data-i18n="panel.pinned">固定</button></div></div></header><p class="pin-error hidden" role="alert"></p>
        <div class="list" role="list" data-i18n-aria-label="panel.aria"></div><footer class="foot"><span data-i18n="panel.footer">↑ ↓ 选择 · Enter 插入</span><span class="count"></span></footer>
      </section>
      <dialog class="clear-dialog" aria-labelledby="aih-clear-title" aria-describedby="aih-clear-copy">
        <div class="confirm-body"><div class="confirm-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 8v5m0 3.5v.5M10.3 4.8 3.7 17a2 2 0 0 0 1.8 3h13a2 2 0 0 0 1.8-3L13.7 4.8a2 2 0 0 0-3.4 0Z" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
        <h2 class="confirm-title" id="aih-clear-title" data-i18n="clear.title">清除所有历史记录？</h2><p class="confirm-copy" id="aih-clear-copy" data-i18n="clear.copy">草稿、自动快照和发送记录都将被永久删除，此操作无法撤销。</p><p class="confirm-error hidden" role="alert"></p></div>
        <div class="confirm-actions"><button class="confirm-button confirm-cancel" type="button" data-i18n="clear.cancel">取消</button><button class="confirm-button danger confirm-accept" type="button" data-i18n="clear.confirm">确认清除</button></div>
      </dialog>`;
    }

    bindEvents() {
      this.launcherDrag = namespace.enablePointerDrag({
        element: this.launcher,
        delay: 360,
        onMove: (position) => this.applyPosition("launcher", position),
        onEnd: (position) => this.persistPosition("launcher", position)
      });
      this.panelDrag = namespace.enablePointerDrag({
        element: this.panel,
        handle: this.shadow.querySelector(".title-row"),
        canStart: (event) => !event.target.closest("button"),
        onMove: (position) => this.applyPosition("panel", position),
        onEnd: (position) => this.persistPosition("panel", position)
      });
      this.launcher.addEventListener("click", () => {
        if (!this.launcherDrag.shouldSuppressClick()) this.open().catch((error) => this.reportError(error));
      });
      this.launcher.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.disableLauncher().catch((error) => this.reportError(error));
      });
      this.launcher.addEventListener("pointerenter", () => this.positionLauncherTooltip());
      this.launcher.addEventListener("focus", () => this.positionLauncherTooltip());
      this.shadow.querySelector(".close").addEventListener("click", () => this.close());
      this.shadow.querySelector(".clear").addEventListener("click", () => this.openClearConfirmation());
      this.search.addEventListener("input", () => this.refresh());
      this.shadow.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
        this.sendOnly = button.dataset.filter === "send";
        this.pinnedOnly = button.dataset.filter === "pinned";
        this.shadow.querySelectorAll(".filter").forEach((item) => {
          item.classList.toggle("active", item === button);
          item.setAttribute("aria-pressed", String(item === button));
        });
        this.refresh();
      }));
      this.list.addEventListener("click", (event) => {
        const pin = event.target.closest(".pin-button");
        if (pin) { this.togglePin(Number(pin.dataset.index), pin); return; }
        const item = event.target.closest(".item");
        if (item) this.choose(Number(item.dataset.index));
      });
    }

    setTarget(element) {
      this.target = element;
      this.launcher.classList.toggle("hidden", !this.launcherEnabled);
      this.positionsReady.then(() => this.reposition());
    }

    setLauncherEnabled(enabled) {
      this.launcherEnabled = enabled;
      this.launcher.classList.toggle("hidden", !enabled || !this.target);
    }

    /** Applies a new interface language without rebuilding the panel. */
    setLanguage(language) {
      namespace.i18n.setLanguage(language);
      namespace.i18n.localize(this.shadow);
      this.siteFilter.refreshLabels();
      this.setLastSavedAt(this.lastSavedAt);
      this.render();
    }

    showSavedFeedback(savedAt = Date.now()) {
      this.setLastSavedAt(savedAt);
      if (this.timingView?.active) return;
      if (!this.launcherEnabled && !this.isOpen()) return;
      clearTimeout(this.savedFeedbackTimer);
      this.launcher.classList.remove("aih-saved");
      this.panel.classList.remove("aih-saved");
      void this.launcher.offsetWidth;
      if (this.launcherEnabled && this.target) this.launcher.classList.add("aih-saved");
      if (this.isOpen()) this.panel.classList.add("aih-saved");
      this.savedStatus.textContent = "";
      requestAnimationFrame(() => { this.savedStatus.textContent = namespace.i18n.t("panel.savedLive"); });
      this.savedFeedbackTimer = setTimeout(() => {
        this.launcher.classList.remove("aih-saved");
        this.panel.classList.remove("aih-saved");
      }, 1_150);
    }

    /** Updates the hover label with the latest automatic snapshot time for this site. */
    setLastSavedAt(savedAt) {
      this.lastSavedAt = Number(savedAt) || 0;
      this.launcherTooltip.textContent = this.lastSavedAt
        ? namespace.i18n.t("panel.lastSaved", { time: formatSavedTime(this.lastSavedAt) })
        : namespace.i18n.t("panel.neverSaved");
    }

    /** Reads the latest automatic snapshot time from local extension storage. */
    async loadLastSavedTime() {
      const state = await this.store.getState();
      this.syncLastSavedTime(state);
    }

    /** Applies a storage state received from another browser window. */
    syncLastSavedTime(state) {
      this.setLastSavedAt(namespace.historyModel.latestSnapshotTime(state?.entries || [], this.site));
    }

    /** Keeps the saved-time tooltip on the side with enough viewport space. */
    positionLauncherTooltip() {
      const rect = this.launcher.getBoundingClientRect();
      const rightSpace = window.innerWidth - rect.right - 9;
      const leftSpace = rect.left - 9;
      const openLeft = rightSpace < 210 && leftSpace > rightSpace;
      this.launcher.classList.toggle("tooltip-left", openLeft);
      const availableWidth = `${Math.max(80, Math.floor(openLeft ? leftSpace : rightSpace))}px`;
      this.launcherTooltip.style.maxWidth = availableWidth;
    }

    async disableLauncher() {
      await this.store.patchSettings({ launcherEnabled: false });
      this.setLauncherEnabled(false);
    }

    async open() {
      if (!this.target) return;
      const revision = ++this.openRevision;
      await this.positionsReady;
      if (revision !== this.openRevision) return;
      this.panel.classList.remove("hidden");
      await this.loadSites();
      await this.refresh();
      if (revision !== this.openRevision || !this.isOpen()) return;
      this.reposition();
      this.search.focus();
    }

    close() {
      this.openRevision += 1;
      this.refreshRevision += 1;
      this.closeClearConfirmation();
      this.siteFilter.setExpanded(false);
      this.panel.classList.add("hidden");
      this.search.value = "";
    }

    isOpen() {
      return !this.panel.classList.contains("hidden");
    }

    /** Opens the irreversible clear-history confirmation dialog. */
    openClearConfirmation() {
      this.clearConfirmation.open();
    }

    /** Closes the clear-history confirmation dialog without changing data. */
    closeClearConfirmation() {
      this.clearConfirmation.close();
    }

    /** Reports whether the clear-history confirmation is blocking the panel. */
    isClearConfirmationOpen() {
      return this.clearConfirmation.isOpen();
    }

    isSiteFilterEvent(event) {
      const activeElement = this.shadow.activeElement;
      const filterHasFocus = activeElement && this.shadow.querySelector(".site-filter-host").contains(activeElement);
      return Boolean(this.siteFilter.isFocused() || filterHasFocus || event.composedPath().some((node) => node?.classList?.contains("site-trigger") || node?.classList?.contains("site-option")));
    }

    async refresh() {
      const revision = ++this.refreshRevision;
      const filterKey = JSON.stringify([this.search.value, this.sendOnly, this.selectedSite, this.pinnedOnly]);
      try {
        const items = await this.store.getHistory(this.search.value, this.sendOnly, this.selectedSite, this.pinnedOnly);
        if (revision !== this.refreshRevision) return;
        const selectedId = this.items[this.selectedIndex]?.id;
        const index = filterKey === this.filterKey ? items.findIndex((entry) => entry.id === selectedId) : 0;
        this.items = items;
        this.selectedIndex = Math.max(0, index);
        this.filterKey = filterKey;
        this.shadow.querySelector(".pin-error").classList.add("hidden");
        this.render();
      } catch (error) {
        if (revision === this.refreshRevision) this.reportError(error);
      }
    }

    /** Shows storage failures rather than silently losing the requested action. */
    reportError(error) {
      const box = this.shadow.querySelector(".pin-error");
      box.textContent = namespace.i18n.t("panel.operationFailed");
      box.classList.remove("hidden");
      console.warn("[AI Input History]", error);
    }

    render() {
      this.shadow.querySelector(".count").textContent = namespace.i18n.t("panel.count", { count: this.items.length });
      if (!this.items.length) {
        this.listMarkup = "";
        this.list.innerHTML = `<div class="empty">${escapeHtml(namespace.i18n.t("panel.empty")).replace("\n", "<br>")}</div>`;
        return;
      }
      renderEntries(this);
    }

    /** Changes pin state without inserting text or closing the history panel. */
    async togglePin(index, button) {
      const entry = this.items[index];
      if (!entry || button.disabled || this.pinning.has(entry.id)) return;
      const errorBox = this.shadow.querySelector(".pin-error");
      errorBox.classList.add("hidden");
      button.disabled = true;
      this.pinning.add(entry.id);
      try {
        await this.store.setPinned(entry, !entry.pinned);
        this.pinning.delete(entry.id);
        await this.refresh();
        const nextButton = this.list.querySelector(`.pin-button[data-index="${Math.min(index, this.items.length - 1)}"]`);
        (nextButton || this.search).focus();
      } catch (error) {
        errorBox.textContent = namespace.i18n.t("status.saveFailed");
        errorBox.classList.remove("hidden");
        console.warn("[AI Input History] Pin", error);
      } finally {
        this.pinning.delete(entry.id);
        button.disabled = false;
        this.render();
      }
    }

    moveSelection(delta) {
      if (!this.items.length) return;
      this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
      this.listMarkup = "";
      this.list.querySelectorAll(".item").forEach((item, index) => {
        item.classList.toggle("selected", index === this.selectedIndex);
        item.setAttribute("aria-current", String(index === this.selectedIndex));
      });
      if (this.shadow.activeElement?.classList?.contains("item")) this.list.querySelector(".selected")?.focus({ preventScroll: true });
      this.list.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    }

    choose(index = this.selectedIndex) {
      const entry = this.items[index];
      if (!entry) return;
      this.onSelect(entry.text);
      this.close();
    }

    async clearHistory() {
      await this.store.clearHistory();
      this.onClear?.();
      await this.refresh();
    }

    async loadSites() {
      namespace.SiteProfiles.setSiteIcons(await this.store.getSiteIcons());
      const sites = await this.store.getSites();
      this.siteFilter.setSites(sites);
      this.selectedSite = this.siteFilter.selectedSite;
    }

    async syncFromStorage() {
      if (!this.isOpen()) return;
      await this.loadSites();
      await this.refresh();
    }

    async loadPositions() {
      this.savedPositions = await this.store.getUiPosition(this.site);
      this.manualPositions.launcher = Boolean(this.savedPositions.launcher);
      this.manualPositions.panel = Boolean(this.savedPositions.panel);
    }

    applyPosition(type, position) {
      const element = type === "launcher" ? this.launcher : this.panel;
      const safe = clampPosition(position, element, type === "launcher" ? 8 : 12);
      this.savedPositions[type] = safe;
      Object.assign(element.style, { left: `${safe.x}px`, top: `${safe.y}px` });
    }

    persistPosition(type, position) {
      this.applyPosition(type, position);
      this.manualPositions[type] = true;
      return this.store.saveUiPosition(this.site, type, this.savedPositions[type]);
    }

    reposition() {
      if (!this.target || !this.target.isConnected) return;
      const rect = composerRect(this.target);
      const launcherPosition = this.manualPositions.launcher
        ? this.savedPositions.launcher
        : { x: rect.left - 42, y: rect.top + (rect.height - 34) / 2 };
      this.applyPosition("launcher", launcherPosition);
      this.positionLauncherTooltip();
      if (!this.isOpen()) return;
      if (this.manualPositions.panel) {
        this.applyPosition("panel", this.savedPositions.panel);
        this.siteFilter.positionMenu();
        return;
      }
      const width = Math.min(400, window.innerWidth - 24);
      const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
      const below = window.innerHeight - rect.bottom >= 260;
      const top = below ? Math.min(window.innerHeight - 180, rect.bottom + 10) : Math.max(12, rect.top - Math.min(560, window.innerHeight * .72) - 10);
      this.applyPosition("panel", { x: left, y: top });
      this.siteFilter.positionMenu();
    }
  }

  namespace.HistoryPanel = HistoryPanel;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
