(function initializeHistoryPanelUtils(namespace) {
  "use strict";

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

  function formatSavedTime(timestamp) {
    const date = new Date(timestamp);
    const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
    if (date.toDateString() === new Date().toDateString()) return `今天 ${time}`;
    const day = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    return `${day} ${time}`;
  }

  namespace.historyPanelUtils = { badgeMarkup, clampPosition, composerRect, enterIcon, escapeHtml, formatSavedTime, formatTime };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
