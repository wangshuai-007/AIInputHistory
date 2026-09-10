(function initializeHistoryPanelUtils(namespace) {
  "use strict";

  function escapeHtml(value) {
    return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]);
  }

  function badgeMarkup(kind) {
    if (kind === "send") return `<span class="badge">${enterIcon()}${namespace.i18n.t("panel.send")}</span>`;
    if (kind === "draft") return `<span class="badge">${namespace.i18n.t("panel.draft")}</span>`;
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
    return new Intl.DateTimeFormat(namespace.i18n.locale(), options).format(date);
  }

  function formatSavedTime(timestamp) {
    const date = new Date(timestamp);
    const time = new Intl.DateTimeFormat(namespace.i18n.locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
    if (date.toDateString() === new Date().toDateString()) return namespace.i18n.t("panel.today", { time });
    const day = new Intl.DateTimeFormat(namespace.i18n.locale(), { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    return `${day} ${time}`;
  }

  /** Formats request completion metadata without inventing durations for unfinished observations. */
  function timingMarkup(entry) {
    if (entry.kind !== "send" || !entry.requestTiming) return "";
    const timing = entry.requestTiming;
    if (timing.status !== "completed" || !Number.isFinite(timing.durationMs) || !Number.isFinite(timing.completedAt)) {
      const status = ["pending", "cancelled", "failed", "timeout"].includes(timing.status) ? timing.status : "pending";
      return `<span class="reply-timing">${escapeHtml(namespace.i18n.t(`timing.${status}`))}</span>`;
    }
    const duration = namespace.i18n.t("timing.duration", { seconds: (timing.durationMs / 1000).toFixed(1) });
    const time = new Intl.DateTimeFormat(namespace.i18n.locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(timing.completedAt));
    return `<span class="reply-timing" title="${escapeHtml(formatSavedTime(timing.completedAt))}"><span>${escapeHtml(duration)}</span><span>${escapeHtml(namespace.i18n.t("timing.replyAt", { time }))}</span></span>`;
  }

  /** Renders history only when needed, retaining scroll position and focused entry. */
  function renderEntries(panel) {
    const markup = panel.items.map((entry, index) => entryMarkup(entry, index, panel)).join("");
    if (panel.listMarkup === markup) return;
    const active = panel.shadow.activeElement;
    const focusedId = active?.closest(".entry-row")?.dataset.entryId;
    const focusedClass = active?.classList.contains("pin-button") ? ".pin-button" : ".item";
    const scrollTop = panel.list.scrollTop;
    panel.list.innerHTML = markup;
    panel.listMarkup = markup;
    panel.list.scrollTop = scrollTop;
    if (focusedId) {
      const row = [...panel.list.querySelectorAll(".entry-row")].find((item) => item.dataset.entryId === focusedId);
      (row?.querySelector(focusedClass) || panel.search).focus({ preventScroll: true });
    }
  }

  function entryMarkup(entry, index, panel) {
    const pinned = entry.pinned ? `<span class="pin-badge">${escapeHtml(namespace.i18n.t("panel.pinned"))}</span>` : "";
    const pinLabel = escapeHtml(namespace.i18n.t(entry.pinned ? "panel.unpin" : "panel.pin"));
    const selected = index === panel.selectedIndex;
    return `<div class="entry-row ${entry.pinned ? "pinned" : ""}" role="listitem" data-entry-id="${escapeHtml(entry.id)}">
      <button class="item ${selected ? "selected" : ""}" type="button" aria-current="${selected}" data-index="${index}">
      <span class="item-top">${pinned}${badgeMarkup(entry.kind)}<span class="time" title="${escapeHtml(formatSavedTime(entry.createdAt))}"><span class="time-short">${formatTime(entry.createdAt)}</span><span class="time-precise">${new Intl.DateTimeFormat(namespace.i18n.locale(), { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(entry.createdAt))}</span></span><span class="site">${escapeHtml(entry.site || namespace.i18n.t("panel.local"))}</span></span>
      <span class="content">${escapeHtml(entry.text)}</span>${timingMarkup(entry)}</button>
      <button class="icon-button pin-button" type="button" data-index="${index}" aria-pressed="${Boolean(entry.pinned)}" title="${pinLabel}" aria-label="${pinLabel}" ${panel.pinning.has(entry.id) ? "disabled" : ""}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m16 3 5 5-3 1-4 4v4l-3-3-6 6 6-6-3-3h4l4-4 1-3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button></div>`;
  }

  namespace.historyPanelUtils = { badgeMarkup, clampPosition, composerRect, enterIcon, escapeHtml, formatSavedTime, formatTime, renderEntries, timingMarkup };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
