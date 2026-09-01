(function initializeHistoryPanel(namespace) {
  "use strict";

  const STYLE = `
    :host { all:initial; color-scheme:light dark; --bg:#111713; --surface:#19211c; --line:#304036; --text:#f0f5f1; --muted:#9aaba0; --accent:#7bd89b; --accent-strong:#a6efbd; font-family:"Segoe UI","Microsoft YaHei UI",sans-serif; }
    * { box-sizing:border-box; } button,input { font:inherit; }
    .launcher { position:fixed; z-index:2147483646; width:34px; height:34px; border:1px solid color-mix(in srgb,var(--accent) 45%,var(--line)); border-radius:11px; background:var(--bg); color:var(--accent-strong); display:grid; place-items:center; box-shadow:0 8px 26px rgba(0,0,0,.28); cursor:pointer; touch-action:none; transition:transform .16s ease,background .16s ease; }
    .launcher:hover { transform:translateY(-2px); background:var(--surface); }
    .launcher.aih-dragging { cursor:grabbing; transform:scale(1.05); }
    .launcher:focus-visible,.icon-button:focus-visible,.filter:focus-visible,.item:focus-visible,input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .launcher svg { width:18px; height:18px; }
    .panel { position:fixed; z-index:2147483647; width:min(400px,calc(100vw - 24px)); max-height:min(560px,72vh); background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:18px; box-shadow:0 22px 60px rgba(0,0,0,.42); overflow:hidden; display:flex; flex-direction:column; animation:aih-in .16s ease-out; }
    .panel.site-menu-open { overflow:visible; }
    .hidden { display:none; } @keyframes aih-in { from { opacity:0; transform:translateY(8px) scale(.98); } }
    .head { position:relative; z-index:2; padding:16px 16px 12px; border-bottom:1px solid var(--line); border-radius:17px 17px 0 0; background:linear-gradient(140deg,var(--surface),var(--bg)); }
    .title-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; cursor:grab; user-select:none; touch-action:none; }
    .panel.aih-dragging .title-row { cursor:grabbing; }
    .title { font-size:15px; font-weight:700; letter-spacing:.02em; } .hint { color:var(--muted); font-size:11px; margin-left:8px; }
    .actions { display:flex; gap:3px; }
    .icon-button { width:30px; height:30px; border:0; border-radius:9px; background:transparent; color:var(--muted); cursor:pointer; display:grid; place-items:center; }
    .icon-button:hover { background:var(--surface); color:var(--text); }
    .icon-button svg { width:16px; height:16px; }
    .search { width:100%; height:40px; padding:0 12px; border:1px solid var(--line); border-radius:11px; background:#0d120f; color:var(--text); }
    .filter-row { display:flex; align-items:center; gap:8px; margin-top:10px; }
    .site-filter-host { position:relative; min-width:0; flex:1; }
    .site-trigger { width:100%; height:32px; border:1px solid var(--line); border-radius:9px; padding:0 8px; background:var(--surface); color:var(--text); display:flex; align-items:center; gap:7px; cursor:pointer; font-size:11px; }
    .site-trigger span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .chevron { width:14px; height:14px; margin-left:auto; flex:0 0 auto; color:var(--muted); }
    .site-menu { position:absolute; z-index:10; left:0; width:min(320px,calc(100vw - 24px)); max-height:min(420px,calc(100vh - 24px)); overflow:auto; overscroll-behavior:contain; padding:6px; border:1px solid var(--line); border-radius:12px; background:var(--bg); box-shadow:0 16px 38px rgba(0,0,0,.34); scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
    .site-option { width:100%; border:0; border-radius:9px; padding:8px; background:transparent; color:var(--text); display:flex; align-items:center; gap:9px; text-align:left; cursor:pointer; }
    .site-option:hover,.site-option.selected { background:var(--surface); }
    .site-option>span { min-width:0; display:flex; flex-direction:column; gap:2px; }
    .site-option strong { overflow:hidden; text-overflow:ellipsis; font-size:12px; font-weight:650; white-space:nowrap; }
    .site-option small { overflow:hidden; text-overflow:ellipsis; color:var(--muted); font-size:10px; white-space:nowrap; }
    .ai-logo { width:17px; height:17px; flex:0 0 auto; color:var(--muted); fill:currentColor; object-fit:contain; border-radius:4px; }
    .ai-logo.gemini { color:#7188f5; } .ai-logo.grok { color:var(--text); } .ai-logo.glm { color:#4ea5ff; } .ai-logo.qwen { color:#8c69ef; } .ai-logo.all { color:var(--accent-strong); }
    .ai-logo.chatgpt { color:#10a37f; } .ai-logo.claude { color:#d97757; } .ai-logo.aistudio { color:#4285f4; } .ai-logo.deepseek { color:#4d6bfe; }
    .ai-logo.copilot { color:#35a7ff; } .ai-logo.perplexity { color:#20a39e; } .ai-logo.kimi { color:#5b6cff; } .ai-logo.doubao { color:#ff5a69; }
    .ai-logo.yuanbao { color:#1b88ff; } .ai-logo.ernie { color:#2769e8; } .ai-logo.mistral { color:#f28c28; } .ai-logo.poe { color:#5d5fef; } .ai-logo.meta { color:#1877f2; } .ai-logo.you { color:#7a5cff; }
    .filters { display:flex; gap:7px; }
    .filter { border:1px solid var(--line); border-radius:999px; padding:5px 10px; color:var(--muted); background:transparent; cursor:pointer; font-size:12px; }
    .filter.active { color:#0c1710; background:var(--accent); border-color:var(--accent); font-weight:700; }
    .list { overflow:auto; padding:8px; scrollbar-width:thin; scrollbar-color:var(--line) transparent; }
    .item { width:100%; border:0; border-radius:12px; background:transparent; color:var(--text); padding:11px 12px; text-align:left; cursor:pointer; display:block; }
    .item:hover,.item.selected { background:var(--surface); }
    .item-top { display:flex; align-items:center; gap:7px; margin-bottom:6px; }
    .badge { color:#0c1710; background:var(--accent); border-radius:999px; padding:2px 7px; font-size:10px; font-weight:800; display:inline-flex; align-items:center; gap:3px; }
    .badge svg,.filter svg { width:12px; height:12px; }
    .filter { display:inline-flex; align-items:center; gap:4px; }
    .time,.site { color:var(--muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .site { margin-left:auto; max-width:140px; }
    .content { font-size:13px; line-height:1.48; white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3; overflow:hidden; }
    .empty { min-height:170px; display:grid; place-items:center; text-align:center; color:var(--muted); font-size:13px; line-height:1.65; padding:30px; }
    .foot { border-top:1px solid var(--line); color:var(--muted); padding:9px 16px; font-size:11px; display:flex; justify-content:space-between; }
    @media (prefers-color-scheme:light) { :host { --bg:#fbfdfb; --surface:#edf4ef; --line:#cbd9cf; --text:#17221a; --muted:#66766b; --accent:#2f8f53; --accent-strong:#287b48; } .search { background:#fff; } .filter.active,.badge { color:#fff; } }
    :host([data-theme="dark"]) { --bg:#111713; --surface:#19211c; --line:#304036; --text:#f0f5f1; --muted:#9aaba0; --accent:#7bd89b; --accent-strong:#a6efbd; }
    :host([data-theme="dark"]) .search { background:#0d120f; } :host([data-theme="dark"]) .filter.active,:host([data-theme="dark"]) .badge { color:#0c1710; }
    :host([data-theme="light"]) { --bg:#fbfdfb; --surface:#edf4ef; --line:#cbd9cf; --text:#17221a; --muted:#66766b; --accent:#2f8f53; --accent-strong:#287b48; }
    :host([data-theme="light"]) .search { background:#fff; } :host([data-theme="light"]) .filter.active,:host([data-theme="light"]) .badge { color:#fff; }
    @media (prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important; } }
  `;

  class HistoryPanel {
    constructor(store, onSelect, onClear) {
      this.store = store;
      this.onSelect = onSelect;
      this.onClear = onClear;
      this.items = [];
      this.selectedIndex = 0;
      this.sendOnly = false;
      this.site = location.hostname;
      this.selectedSite = this.site;
      this.launcherEnabled = true;
      this.savedPositions = {};
      this.manualPositions = { launcher: false, panel: false };
      this.host = document.createElement("div");
      this.host.dataset.aiInputHistory = "root";
      this.shadow = this.host.attachShadow({ mode: globalThis.__AIH_TEST_OPEN_SHADOW === true ? "open" : "closed" });
      this.shadow.innerHTML = `<style>${STYLE}</style>${this.markup()}`;
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
      this.bindEvents();
      this.positionsReady = this.loadPositions();
    }

    markup() {
      return `<button class="launcher hidden" type="button" aria-label="打开输入历史；长按移动；右键隐藏" title="点击打开 · 长按移动 · 右键隐藏">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h11M4 12h11M4 17h7M18 15v6m-3-3h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
      </button>
      <section class="panel hidden" role="dialog" aria-label="输入历史">
        <header class="head"><div class="title-row"><div><span class="title">输入历史</span><span class="hint">拖动标题移动</span></div><div class="actions">
          <button class="icon-button clear" type="button" aria-label="一键清除全部历史" title="一键清除全部历史"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <button class="icon-button close" type="button" aria-label="关闭" title="关闭"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        </div></div>
        <input class="search" type="search" placeholder="搜索本地历史…" aria-label="搜索输入历史">
        <div class="filter-row"><div class="site-filter-host"></div>
        <div class="filters"><button class="filter active" data-filter="all" type="button">全部</button><button class="filter" data-filter="send" type="button">${enterIcon()}发送</button></div></div></header>
        <div class="list" role="listbox"></div><footer class="foot"><span>↑ ↓ 选择 · Enter 插入</span><span class="count">0 条</span></footer>
      </section>`;
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
        if (!this.launcherDrag.shouldSuppressClick()) this.open();
      });
      this.launcher.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.disableLauncher();
      });
      this.shadow.querySelector(".close").addEventListener("click", () => this.close());
      this.shadow.querySelector(".clear").addEventListener("click", () => this.clearHistory());
      this.search.addEventListener("input", () => this.refresh());
      this.shadow.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
        this.sendOnly = button.dataset.filter === "send";
        this.shadow.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
        this.refresh();
      }));
      this.list.addEventListener("click", (event) => {
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

    async disableLauncher() {
      this.setLauncherEnabled(false);
      const settings = await this.store.getSettings();
      await this.store.saveSettings({ ...settings, launcherEnabled: false });
    }

    async open() {
      if (!this.target) return;
      await this.positionsReady;
      this.panel.classList.remove("hidden");
      await this.loadSites();
      await this.refresh();
      this.reposition();
      this.search.focus();
    }

    close() {
      this.siteFilter.setExpanded(false);
      this.panel.classList.add("hidden");
      this.search.value = "";
    }

    isOpen() {
      return !this.panel.classList.contains("hidden");
    }

    isSiteFilterEvent(event) {
      const activeElement = this.shadow.activeElement;
      const filterHasFocus = activeElement && this.shadow.querySelector(".site-filter-host").contains(activeElement);
      return Boolean(this.siteFilter.isFocused() || filterHasFocus || event.composedPath().some((node) => node?.classList?.contains("site-trigger") || node?.classList?.contains("site-option")));
    }

    async refresh() {
      this.items = await this.store.getHistory(this.search.value, this.sendOnly, this.selectedSite);
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1));
      this.render();
    }

    render() {
      this.shadow.querySelector(".count").textContent = `${this.items.length} 条`;
      if (!this.items.length) {
        this.list.innerHTML = `<div class="empty">暂无匹配记录<br>输入内容按设置的秒数保存，确认实际发送后会特殊标记。</div>`;
        return;
      }
      this.list.innerHTML = this.items.map((entry, index) => `<button class="item ${index === this.selectedIndex ? "selected" : ""}" type="button" role="option" aria-selected="${index === this.selectedIndex}" data-index="${index}">
        <span class="item-top">${badgeMarkup(entry.kind)}<span class="time">${formatTime(entry.createdAt)}</span><span class="site">${escapeHtml(entry.site || "本地")}</span></span>
        <span class="content">${escapeHtml(entry.text)}</span></button>`).join("");
    }

    moveSelection(delta) {
      if (!this.items.length) return;
      this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
      this.render();
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

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  }

  function badgeMarkup(kind) {
    if (kind === "send") return `<span class="badge">${enterIcon()}发送</span>`;
    if (kind === "draft") return '<span class="badge">草稿</span>';
    return "";
  }

  function enterIcon() {
    return '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M13 3v4.2c0 1.1-.9 2-2 2H4m3-3-3 3 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function clampPosition(position, element, margin) {
    const rect = element.getBoundingClientRect();
    const width = rect.width || (element.classList.contains("launcher") ? 34 : Math.min(400, window.innerWidth - 24));
    const height = rect.height || (element.classList.contains("launcher") ? 34 : 180);
    return {
      x: Math.max(margin, Math.min(window.innerWidth - width - margin, position.x)),
      y: Math.max(margin, Math.min(window.innerHeight - height - margin, position.y))
    };
  }

  function composerRect(target) {
    const targetRect = target.getBoundingClientRect();
    let selected = targetRect;
    let ancestor = target.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
      const rect = ancestor.getBoundingClientRect();
      const reasonableHeight = rect.height <= Math.max(220, targetRect.height + 140);
      const widerContainer = rect.width >= targetRect.width + 60;
      if (reasonableHeight && widerContainer && rect.width < window.innerWidth) selected = rect;
    }
    return selected;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const sameDay = date.toDateString() === new Date().toDateString();
    const options = sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
    return new Intl.DateTimeFormat("zh-CN", options).format(date);
  }

  namespace.HistoryPanel = HistoryPanel;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
