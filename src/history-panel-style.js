(function(namespace) {
  "use strict";
  namespace.historyPanelStyle = `
    :host { all:initial; color-scheme:light dark; --bg:#111713; --surface:#19211c; --line:#304036; --text:#f0f5f1; --muted:#9aaba0; --accent:#7bd89b; --accent-strong:#a6efbd; font-family:"Segoe UI","Microsoft YaHei UI",sans-serif; }
    * { box-sizing:border-box; } button,input { font:inherit; }
    .launcher { position:fixed; z-index:2147483646; width:34px; height:34px; border:1px solid color-mix(in srgb,var(--accent) 45%,var(--line)); border-radius:11px; background:var(--bg); color:var(--accent-strong); display:grid; place-items:center; box-shadow:0 8px 26px rgba(0,0,0,.28); cursor:pointer; touch-action:none; transition:transform .16s ease,background .16s ease,border-color .16s ease; }
    .launcher-symbol { position:absolute; display:grid; place-items:center; transition:opacity .16s ease,transform .16s ease; }
    .launcher-save { opacity:0; transform:scale(.55) translateY(2px); }
    .launcher.aih-saved { border-color:var(--accent-strong); animation:aih-save-pop .72s ease-out; }
    .launcher.aih-saved::after { content:""; position:absolute; inset:-1px; border:2px solid var(--accent); border-radius:12px; pointer-events:none; animation:aih-save-ring .72s ease-out; }
    .launcher.aih-saved .launcher-history { opacity:0; transform:scale(.65); }
    .launcher.aih-saved .launcher-save { opacity:1; transform:scale(1) translateY(0); }
    .launcher-tooltip { position:absolute; z-index:2; left:calc(100% + 9px); top:50%; width:max-content; max-width:min(240px,calc(100vw - 58px)); padding:7px 10px; border:1px solid var(--line); border-radius:9px; background:var(--bg); color:var(--text); box-shadow:0 8px 24px rgba(0,0,0,.3); font-size:11px; line-height:1.35; white-space:normal; overflow-wrap:anywhere; opacity:0; visibility:hidden; pointer-events:none; transform:translateY(-50%) translateX(-3px); transition:opacity .14s ease,transform .14s ease,visibility .14s ease; }
    .launcher.tooltip-left .launcher-tooltip { left:auto; right:calc(100% + 9px); transform:translateY(-50%) translateX(3px); }
    .launcher:hover .launcher-tooltip,.launcher:focus-visible .launcher-tooltip { opacity:1; visibility:visible; transform:translateY(-50%) translateX(0); }
    .launcher:hover { transform:translateY(-2px); background:var(--surface); }
    .launcher.aih-dragging { cursor:grabbing; transform:scale(1.05); }
    .launcher:focus-visible,.icon-button:focus-visible,.filter:focus-visible,.item:focus-visible,input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .launcher svg { width:18px; height:18px; }
    .panel { position:fixed; z-index:2147483647; width:min(400px,calc(100vw - 24px)); max-height:min(560px,72vh); background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:18px; box-shadow:0 22px 60px rgba(0,0,0,.42); overflow:hidden; display:flex; flex-direction:column; animation:aih-in .16s ease-out; }
    .panel.site-menu-open { overflow:visible; }
    .hidden { display:none; } .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
    @keyframes aih-in { from { opacity:0; transform:translateY(8px) scale(.98); } }
    @keyframes aih-save-pop { 0%,100% { transform:scale(1); } 38% { transform:scale(1.14); background:var(--surface); } }
    @keyframes aih-save-ring { 0% { opacity:.9; transform:scale(.82); } 100% { opacity:0; transform:scale(1.55); } }
    @keyframes aih-panel-saved { 0%,100% { box-shadow:0 22px 60px rgba(0,0,0,.42); } 35% { box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 55%,transparent),0 22px 60px rgba(0,0,0,.42); } }
    @keyframes aih-dialog-in { from { opacity:0; transform:translateY(5px) scale(.98); } }
    .panel.aih-saved { animation:aih-panel-saved .72s ease-out; }
    .head { position:relative; z-index:2; padding:16px 16px 12px; border-bottom:1px solid var(--line); border-radius:17px 17px 0 0; background:linear-gradient(140deg,var(--surface),var(--bg)); }
    .title-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; cursor:grab; user-select:none; touch-action:none; }
    .panel.aih-dragging .title-row { cursor:grabbing; }
    .title { font-size:15px; font-weight:700; letter-spacing:.02em; } .hint { color:var(--muted); font-size:11px; margin-left:8px; }
    .actions { display:flex; gap:3px; }
    .icon-button { width:30px; height:30px; border:0; border-radius:9px; background:transparent; color:var(--muted); cursor:pointer; display:grid; place-items:center; }
    .icon-button:hover { background:var(--surface); color:var(--text); }
    .icon-button svg { width:16px; height:16px; }
    .clear-dialog { width:min(320px,calc(100vw - 32px)); padding:0; border:1px solid var(--line); border-radius:16px; background:var(--bg); color:var(--text); box-shadow:0 24px 70px rgba(0,0,0,.5); }
    .clear-dialog::backdrop { background:rgba(4,9,6,.58); backdrop-filter:blur(2px); }
    .clear-dialog[open] { animation:aih-dialog-in .14s ease-out; }
    .confirm-body { padding:19px 19px 13px; }
    .confirm-icon { width:34px; height:34px; margin-bottom:11px; border-radius:11px; display:grid; place-items:center; background:color-mix(in srgb,#ef756b 14%,var(--surface)); color:#ef9f95; }
    .confirm-icon svg { width:18px; height:18px; }
    .confirm-title { margin:0 0 6px; font-size:15px; }
    .confirm-copy { margin:0; color:var(--muted); font-size:12px; line-height:1.55; }
    .confirm-error { margin-top:8px; color:#ef9f95; font-size:11px; }
    .confirm-actions { display:flex; justify-content:flex-end; gap:8px; padding:12px 19px 17px; }
    .confirm-button { height:34px; padding:0 13px; border:1px solid var(--line); border-radius:9px; background:var(--surface); color:var(--text); cursor:pointer; font-size:12px; }
    .confirm-button.danger { border-color:#8d4f49; background:#7a3934; color:#fff; font-weight:700; }
    .confirm-button:hover { filter:brightness(1.08); }
    .confirm-button:disabled { opacity:.55; cursor:wait; }
    .search { width:100%; height:40px; padding:0 12px; border:1px solid var(--line); border-radius:11px; background:#0d120f; color:var(--text); }
    .filter-row { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:10px; }
    .site-filter-host { position:relative; min-width:120px; flex:1 1 120px; }
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
    .filters { display:flex; flex:0 0 auto; gap:4px; }
    .filter { border:1px solid var(--line); border-radius:999px; min-height:32px; padding:5px 8px; white-space:nowrap; color:var(--muted); background:transparent; cursor:pointer; font-size:12px; }
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
    @media (prefers-reduced-motion:reduce) { * { animation:none!important; transition:none!important; } .launcher.aih-saved .launcher-history { opacity:0; } .launcher.aih-saved .launcher-save { opacity:1; transform:none; } }
    .entry-row { position:relative; }
    .entry-row .item { padding-right:44px; }
    .entry-row.pinned { border-left:3px solid var(--accent); border-radius:12px; }
    .pin-button { position:absolute; right:5px; top:8px; }
    .pin-button[aria-pressed="true"] { color:var(--accent-strong); background:var(--surface); }
    .pin-badge { color:var(--accent-strong); font-size:10px; white-space:nowrap; }
    .pin-error { color:var(--text); padding:8px 16px; margin:0; border-left:3px solid #c85147; font-size:12px; }
    .pin-button:disabled { opacity:.55; cursor:wait; }
    .request-clock { display:none; font-size:11px; font-weight:650; font-variant-numeric:tabular-nums; }
    .launcher.timing-active { width:auto; min-width:34px; max-width:76px; padding:0 7px; }
    .launcher.timing-active .launcher-symbol { opacity:0; }
    .launcher.timing-active .request-clock { display:block; }
    .time-precise { display:none; }
    .entry-row:hover .time-short,.entry-row:focus-within .time-short { display:none; }
    .entry-row:hover .time-precise,.entry-row:focus-within .time-precise { display:inline; }
    .reply-timing { display:flex; justify-content:flex-end; flex-wrap:wrap; gap:3px 10px; margin-top:8px; color:var(--muted); font-size:10px; font-variant-numeric:tabular-nums; text-align:right; }
    .head,.foot { flex-shrink:0; }
  `;
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
