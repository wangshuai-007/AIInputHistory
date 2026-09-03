(function initializeI18n(namespace) {
  "use strict";

  const MESSAGES = {
    "zh-CN": {
      "app.title": "AI 输入历史", "app.localOnly": "仅保存在这台浏览器中", "language.label": "界面语言",
      "privacy.disclosure": "读取你在已支持 AI 网站输入的内容、页面标题和域名，仅用于本地历史记录；数据不会上传或共享。",
      "summary.label": "存储摘要", "summary.history": "历史记录", "summary.send": "发送记录", "summary.draft": "未发送草稿",
      "settings.title": "记录设置", "settings.historyLimit": "历史上限", "settings.historyLimitHint": "最近输入，按时间倒序",
      "settings.sendLimit": "发送记录上限", "settings.sendLimitHint": "确认实际发送前的内容", "settings.snapshot": "自动快照间隔",
      "settings.snapshotHint": "单位：秒，范围 1–3600", "settings.launcher": "显示悬浮按钮", "settings.launcherHint": "右键隐藏后可在这里重新打开",
      "shortcut.title": "打开历史", "shortcut.hint": "点击按键框，然后按下组合键", "shortcut.aria": "设置打开历史快捷键",
      "shortcut.disable": "停用", "shortcut.help": "组合键需包含 Ctrl、Alt、Shift 或 Windows/Command；也可单独使用 F1–F12。按 Esc 取消录制。",
      "shortcut.recordingAria": "正在录制快捷键，请按组合键", "shortcut.press": "请按组合键…", "shortcut.cancelled": "已取消快捷键录制",
      "shortcut.continue": "继续按一个按键…", "shortcut.modifier": "需包含修饰键", "shortcut.updated": "快捷键已更新并立即生效",
      "shortcut.disabled": "快捷键已停用", "shortcut.empty": "未启用 · 点击设置", "shortcut.space": "空格",
      "domains.title": "自定义追踪域名", "domains.description": "默认只追踪内置 AI 网站。添加域名后，刷新该网站即可启用。",
      "domains.placeholder": "例如：ai.example.com", "domains.aria": "自定义域名", "domains.add": "添加", "domains.empty": "尚未添加自定义域名",
      "domains.remove": "移除 {domain}", "domains.invalid": "请输入有效域名，例如 ai.example.com", "domains.builtin": "该 AI 网站已默认支持，无需添加",
      "domains.exists": "该域名已添加", "domains.added": "域名已添加，刷新该网站后生效", "domains.removed": "域名已移除，刷新页面后停止追踪",
      "status.saved": "设置已保存并立即生效", "status.launcherOn": "悬浮按钮已立即开启", "status.launcherOff": "悬浮按钮已立即关闭",
      "status.saveFailed": "保存失败，请重试", "status.cleared": "本地记录已清空",
      "clear.button": "清空本地记录", "clear.title": "清除所有历史记录？", "clear.copy": "草稿、自动快照和发送记录都将被永久删除，此操作无法撤销。",
      "clear.cancel": "取消", "clear.confirm": "确认清除", "clear.error": "清除失败，请重试。",
      "panel.launcherAria": "打开输入历史；长按移动；右键隐藏", "panel.neverSaved": "尚未自动保存", "panel.aria": "输入历史",
      "panel.title": "输入历史", "panel.dragHint": "拖动标题移动", "panel.clearAria": "一键清除全部历史", "panel.close": "关闭",
      "panel.searchPlaceholder": "搜索本地历史…", "panel.searchAria": "搜索输入历史", "panel.all": "全部", "panel.send": "发送",
      "panel.footer": "↑ ↓ 选择 · Enter 插入", "panel.count": "{count} 条", "panel.empty": "暂无匹配记录\n输入内容按设置的秒数保存，确认实际发送后会特殊标记。",
      "panel.local": "本地", "panel.draft": "草稿", "panel.savedLive": "自动快照已保存", "panel.lastSaved": "上次自动保存：{time}", "panel.today": "今天 {time}",
      "filter.all": "全部网站", "filter.current": "当前 · {name}", "filter.crossSite": "跨站点历史",
      "site.doubao": "豆包", "site.yuanbao": "腾讯元宝", "site.ernie": "文小言"
    },
    en: {
      "app.title": "AI Input History", "app.localOnly": "Stored only in this browser", "language.label": "Interface language",
      "privacy.disclosure": "Reads text you enter on supported AI sites, page titles, and domains only for local history. Data is never uploaded or shared.",
      "summary.label": "Storage summary", "summary.history": "History", "summary.send": "Sent", "summary.draft": "Unsent drafts",
      "settings.title": "Recording", "settings.historyLimit": "History limit", "settings.historyLimitHint": "Most recent first",
      "settings.sendLimit": "Sent history limit", "settings.sendLimitHint": "Text captured immediately before sending", "settings.snapshot": "Auto-save interval",
      "settings.snapshotHint": "Seconds, from 1 to 3600", "settings.launcher": "Show floating button", "settings.launcherHint": "Re-enable it here after hiding with right-click",
      "shortcut.title": "Open history", "shortcut.hint": "Click the key field, then press a shortcut", "shortcut.aria": "Set the open-history shortcut",
      "shortcut.disable": "Disable", "shortcut.help": "Use Ctrl, Alt, Shift, or Windows/Command; F1–F12 may be used alone. Press Esc to cancel recording.",
      "shortcut.recordingAria": "Recording shortcut; press a key combination", "shortcut.press": "Press a shortcut…", "shortcut.cancelled": "Shortcut recording cancelled",
      "shortcut.continue": "Press one more key…", "shortcut.modifier": "Add a modifier key", "shortcut.updated": "Shortcut updated and active",
      "shortcut.disabled": "Shortcut disabled", "shortcut.empty": "Disabled · Click to set", "shortcut.space": "Space",
      "domains.title": "Custom tracked domains", "domains.description": "Only built-in AI sites are tracked by default. Add a domain, then refresh that site to enable it.",
      "domains.placeholder": "Example: ai.example.com", "domains.aria": "Custom domain", "domains.add": "Add", "domains.empty": "No custom domains yet",
      "domains.remove": "Remove {domain}", "domains.invalid": "Enter a valid domain, such as ai.example.com", "domains.builtin": "This AI site is already supported",
      "domains.exists": "This domain has already been added", "domains.added": "Domain added; refresh the site to enable it", "domains.removed": "Domain removed; refresh the page to stop tracking",
      "status.saved": "Settings saved and active", "status.launcherOn": "Floating button enabled", "status.launcherOff": "Floating button disabled",
      "status.saveFailed": "Could not save. Try again.", "status.cleared": "Local history cleared",
      "clear.button": "Clear local history", "clear.title": "Clear all history?", "clear.copy": "Drafts, automatic snapshots, and sent entries will be permanently deleted. This cannot be undone.",
      "clear.cancel": "Cancel", "clear.confirm": "Clear history", "clear.error": "Could not clear history. Try again.",
      "panel.launcherAria": "Open input history; hold to move; right-click to hide", "panel.neverSaved": "Not auto-saved yet", "panel.aria": "Input history",
      "panel.title": "Input history", "panel.dragHint": "Drag the title to move", "panel.clearAria": "Clear all history", "panel.close": "Close",
      "panel.searchPlaceholder": "Search local history…", "panel.searchAria": "Search input history", "panel.all": "All", "panel.send": "Sent",
      "panel.footer": "↑ ↓ Select · Enter Insert", "panel.count": "{count} items", "panel.empty": "No matching entries\nInput is saved at the configured interval and marked when it is actually sent.",
      "panel.local": "Local", "panel.draft": "Draft", "panel.savedLive": "Automatic snapshot saved", "panel.lastSaved": "Last auto-save: {time}", "panel.today": "Today {time}",
      "filter.all": "All sites", "filter.current": "Current · {name}", "filter.crossSite": "History across sites",
      "site.doubao": "Doubao", "site.yuanbao": "Tencent Yuanbao", "site.ernie": "ERNIE"
    }
  };
  let language = "zh-CN";

  /** Normalizes user language settings to one of the supported locale identifiers. */
  function normalizeLanguage(value) {
    return value === "en" ? "en" : "zh-CN";
  }

  /** Changes the active in-memory interface language. */
  function setLanguage(value) {
    language = normalizeLanguage(value);
    return language;
  }

  /** Resolves and interpolates one translated message. */
  function t(key, variables = {}, fallback = key) {
    const template = MESSAGES[language][key] ?? MESSAGES["zh-CN"][key] ?? fallback;
    return String(template).replace(/\{(\w+)\}/g, (_, name) => variables[name] ?? `{${name}}`);
  }

  /** Applies data-i18n attributes within a Document or ShadowRoot. */
  function localize(root) {
    root.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = t(element.dataset.i18n); });
    [["data-i18n-aria-label", "aria-label"], ["data-i18n-title", "title"], ["data-i18n-placeholder", "placeholder"]]
      .forEach(([selector, attribute]) => root.querySelectorAll(`[${selector}]`).forEach((element) => element.setAttribute(attribute, t(element.getAttribute(selector)))));
  }

  namespace.i18n = { language: () => language, locale: () => language === "en" ? "en-US" : "zh-CN", localize, normalizeLanguage, setLanguage, t };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
