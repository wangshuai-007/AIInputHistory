(function initializeProBadge(namespace) {
  "use strict";
  const MARKER = "data-aih-pro-remaining";

  function displayFor(modelId, plan, stats, quota, now = Date.now()) {
    const direct = namespace.proQuotaModel?.activeStatus(quota?.[modelId], now);
    const sharedPlan = ["pro-100", "business-standard", "business-premium"].includes(plan);
    const shared = sharedPlan ? namespace.proQuotaModel?.activeStatus(quota?.pro, now) : null;
    const official = direct || shared;
    if (official?.status === "remaining-shown" && Number.isSafeInteger(official.remaining)) {
      return {
        text: "剩余 " + official.remaining,
        detail: "ChatGPT 页面显示的剩余 Pro 次数；观察时间 " +
          new Date(official.observedAt).toLocaleString(),
        kind: "ui"
      };
    }
    if (official?.status === "limit-reached") {
      return {
        text: "剩余 0",
        detail: "ChatGPT 页面提示当前 Pro 额度已经用尽；这不是扩展自行计算的余额。",
        kind: "ui"
      };
    }
    const computed = namespace.proUsageModel?.remainingEstimate({ plan, modelId, stats, now });
    if (!computed) {
      // Pro $200 has model-specific caps. A composer labelled only "Pro"
      // cannot identify which model's cap applies, but its shared DAILY
      // 200-use ceiling can still be shown as an explicit upper bound.
      if (plan === "pro-200" && modelId === "pro") {
        const today = namespace.proUsageModel?.summarize(stats, now)?.all?.today || 0;
        const ceiling = Math.max(0, 200 - today);
        return {
          text: "≤" + ceiling,
          detail: "本机推算的两种 Pro 模型共享每日最多剩余 " + ceiling +
            " 次。未识别具体 Pro 模型，个人模型上限可能更低；不是 ChatGPT 官方剩余次数。",
          kind: "upper-bound"
        };
      }
      return {
        text: "剩余 ?",
        detail: plan === "unknown"
          ? "请在扩展设置中选择账号套餐。无法直接确认套餐或官方额度。"
          : "此套餐或所选模型缺少可确定的次数上限。",
        kind: "unknown"
      };
    }
    const period = { day: "本机自然日", week: "本机自然周", month: "本机自然月" }[computed.period];
    return {
      text: "≈" + computed.remaining,
      detail: "本机估算剩余 " + computed.remaining + " 次（" + period +
        "，套餐 " + (namespace.proUsageModel.PLAN_LABELS[plan] || "未知") +
        "）。只包含本浏览器记录的次数；不等于官方剩余配额或服务器重置窗口。",
      kind: "estimated"
    };
  }

  // Locate the visible Pro TEXT rather than the full model-button box. Its
  // dropdown arrow and trailing padding are not the requested anchor.
  function proLabelRect(doc, target) {
    if (doc?.createTreeWalker && doc?.createRange) {
      const walker = doc.createTreeWalker(target, 4); // SHOW_TEXT
      let node, scanned = 0;
      while ((node = walker.nextNode()) && scanned++ < 40) {
        if (node.parentElement?.closest?.('svg,[hidden],[aria-hidden="true"]')) continue;
        const text = node.nodeValue || '';
        const match = /(?:\b|\d)pro\b/i.exec(text);
        if (!match) continue;
        const from = match.index + match[0].length - 3;
        try {
          const range = doc.createRange();
          range.setStart(node, from); range.setEnd(node, from + 3);
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return rect;
        } catch { /* React can detach a text node during selection. */ }
      }
    }
    return target?.getBoundingClientRect?.() || null;
  }

  class ProModelBadge {
    constructor({ documentRef = globalThis.document, host = globalThis.location?.hostname,
      now = Date.now, timer = (fn, delay) => setInterval(fn, delay),
      untimer = (id) => clearInterval(id), Observer = globalThis.MutationObserver } = {}) {
      Object.assign(this, { documentRef, host, now, timer, untimer, Observer });
      this.enabled = false;
      this.plan = "unknown";
      this.stats = null;
      this.quota = null;
      this.started = false;
      this.badge = null;
      this.spacedTarget = null;
    }

    // Minimal, non-sensitive status visible to the PAGE DevTools console.
    // MV3 content scripts are isolated, so AIInputHistory is not reachable
    // directly from the page execution context.
    mark(status) {
      const root = this.documentRef?.documentElement;
      if (!root?.setAttribute) return;
      if (root.getAttribute?.("data-aih-pro-state") !== status) {
        root.setAttribute("data-aih-pro-state", status);
      }
      const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
      if (version && root.getAttribute?.("data-aih-pro-version") !== version) {
        root.setAttribute("data-aih-pro-version", version);
      }
    }

    setSettings(settings) {
      this.enabled = settings?.trackProUsage === true;
      this.plan = Object.hasOwn(namespace.proUsageModel.PLAN_LABELS, settings?.proPlan)
        ? settings.proPlan : "unknown";
      this.render();
    }

    updateUsage(stats) {
      this.stats = stats || null;
      this.render();
    }

    updateQuota(quota) {
      this.quota = quota || null;
      this.render();
    }

    start() {
      if (this.started || !namespace.proQuotaModel?.isChatGPT(this.host)) return;
      this.started = true;
      this.clock = this.timer(() => { if (this.enabled) this.render(); }, 5000);
      const view = this.documentRef?.defaultView;
      if (view?.addEventListener) {
        this.onViewportChange = () => {
          if (this.target && this.badge) this.position(this.target);
        };
        view.addEventListener("resize", this.onViewportChange);
        view.addEventListener("scroll", this.onViewportChange, true);
      }
      if (this.Observer && this.documentRef?.documentElement) {
        let queued = false;
        this.observer = new this.Observer((mutations) => {
          if (!this.enabled || queued || mutations.every((mutation) =>
            (mutation.target?.nodeType === 3 ? mutation.target.parentElement : mutation.target)
              ?.closest?.("[" + MARKER + "]"))) return;
          queued = true;
          Promise.resolve().then(() => { queued = false; this.render(); });
        });
        this.observer.observe(this.documentRef.documentElement, {
          childList: true, subtree: true, attributes: true, characterData: true,
          attributeFilter: ["aria-label", "aria-selected", "aria-checked", "aria-hidden",
            "data-testid", "title", "data-state", "class", "style", "hidden"]
        });
      }
      this.render();
    }

    stop() {
      if (this.clock !== undefined) this.untimer(this.clock);
      this.observer?.disconnect();
      const view = this.documentRef?.defaultView;
      if (this.onViewportChange && view?.removeEventListener) {
        view.removeEventListener("resize", this.onViewportChange);
        view.removeEventListener("scroll", this.onViewportChange, true);
      }
      this.onViewportChange = null;
      this.started = false;
      this.clear();
    }

    clear() {
      this.releaseModelSpacing();
      this.badge?.remove?.();
      this.badge = null;
      this.target = null;
    }

    releaseModelSpacing() {
      const saved = this.spacedTarget;
      if (!saved) return;
      this.spacedTarget = null;
      // Restore only what we changed, including any pre-existing inline rule.
      const style = saved.element?.style;
      if (!style?.setProperty) return;
      // React may change or replace this button while we are active.
      if (style.getPropertyValue("column-gap") === saved.applied) {
        if (saved.original) {
          style.setProperty("column-gap", saved.original, saved.priority);
        } else {
          style.removeProperty("column-gap");
        }
      }
      saved.element.removeAttribute?.("data-aih-pro-gap");
    }

    // Reserve a small piece of space *inside* the native Pro dropdown:
    // Pro (15) ▾, with the number rendered as a lower-right subscript.
    // We must not append React children (React may reconcile them away).
    // Increasing the flex gap moves the chevron while keeping the badge in
    // the actual button's hit rectangle. Restore on model switch/disable.
    reserveModelSpacing(target, width) {
      const view = this.documentRef?.defaultView;
      const style = target?.style;
      if (!view?.getComputedStyle || !style?.setProperty || !target?.querySelector?.("svg")) {
        this.releaseModelSpacing();
        return;
      }
      if (this.spacedTarget?.element !== target) {
        this.releaseModelSpacing();
        const computed = view.getComputedStyle(target);
        if (!/^(?:inline-)?flex$/.test(computed?.display || "")) return;
        const gap = Number.parseFloat(computed.columnGap);
        // A React remount can clone the previous button's DOM and inline
        // spacing. Carry the ORIGINAL gap metadata so the new button does
        // not grow wider on every remount.
        let old = null;
        try { old = JSON.parse(target.getAttribute?.("data-aih-pro-gap") || "null"); }
        catch { /* Other markup must never break our model control. */ }
        const original = old && typeof old.original === "string"
          ? old.original : style.getPropertyValue("column-gap");
        const priority = old && typeof old.priority === "string"
          ? old.priority : style.getPropertyPriority("column-gap");
        const base = old && Number.isFinite(old.base)
          ? old.base : (Number.isFinite(gap) ? gap : 0);
        this.spacedTarget = { element: target, original, priority, base, applied: null };
        target.setAttribute?.("data-aih-pro-gap", JSON.stringify({ original, priority, base }));
      }
      const wanted = Math.ceil(this.spacedTarget.base + width + 3) + "px";
      this.spacedTarget.applied = wanted;
      if (style.getPropertyValue("column-gap") !== wanted) {
        style.setProperty("column-gap", wanted);
      }
    }

    // Keep the count visually INSIDE the native Pro button, between its label
    // and chevron. The overlay node stays in body to avoid touching React
    // children and can never intercept clicks or open a tooltip.
    position(target) {
      if (!this.badge) return;
      const view = this.documentRef?.defaultView;
      const screenWidth = view?.innerWidth || this.documentRef?.documentElement?.clientWidth;
      const screenHeight = view?.innerHeight || this.documentRef?.documentElement?.clientHeight;
      let rect = target?.getBoundingClientRect?.();
      if (!rect || !screenWidth || !screenHeight) return;
      if (!target.isConnected || !rect.width || !rect.height || rect.bottom < 0
        || rect.top > screenHeight || rect.right < 0 || rect.left > screenWidth) {
        this.badge.style.display = "none";
        return;
      }
      this.badge.style.display = "inline-flex";
      const size = this.badge.getBoundingClientRect();
      const width = size.width || 24, height = size.height || 12;
      this.reserveModelSpacing(target, width);
      rect = target.getBoundingClientRect?.() || rect; // Flex width may move.
      const label = proLabelRect(this.documentRef, target);
      const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
      const minLeft = Math.max(2, rect.left + 1);
      const maxLeft = Math.max(minLeft, Math.min(rect.right - width - 1,
        screenWidth - width - 2));
      const minTop = Math.max(2, rect.top + 1);
      const maxTop = Math.max(minTop, Math.min(rect.bottom - height - 1,
        screenHeight - height - 2));
      this.badge.style.left = Math.round(clamp(label.right + 3, minLeft, maxLeft)) + "px";
      this.badge.style.top = Math.round(clamp(label.bottom - height - 1,
        minTop, maxTop)) + "px";
    }

    render() {
      if (!this.enabled || !namespace.proQuotaModel?.isChatGPT(this.host)) {
        this.mark(this.enabled ? "unsupported-site" : "disabled");
        this.clear();
        return;
      }
      let selected;
      try { selected = namespace.proUsageModel.detect(this.documentRef, { composerOnly: true }); }
      catch (error) {
        this.mark("scan-error");
        this.clear();
        console.warn("[AI Input History] Pro model detection failed", error);
        return;
      }
      const target = selected?.element;
      if (!selected || !target?.isConnected) {
        const editorCount = this.documentRef?.querySelectorAll?.(
          namespace.proUsageModel.COMPOSER_EDITOR_SELECTOR)?.length || 0;
        this.mark(editorCount ? "no-pro-control" : "no-composer");
        this.clear();
        return;
      }
      const root = this.documentRef?.body || this.documentRef?.documentElement;
      if (!root?.appendChild) {
        this.mark("no-body");
        return;
      }
      if (!this.badge?.isConnected || this.badge.parentNode !== root) {
        this.clear();
        const badge = this.documentRef.createElement("span");
        badge.setAttribute(MARKER, "");
        badge.setAttribute("aria-hidden", "true");
        badge.style.cssText = [
          "position:fixed", "z-index:2147483645", "display:inline-flex",
          "align-items:center", "white-space:nowrap", "padding:0", "margin:0",
          "border:0", "background:transparent",
          "color:var(--color-text-tertiary, #6b7280)",
          "font-family:inherit", "font-size:11px", "font-weight:500",
          "font-variant-numeric:tabular-nums", "line-height:12px",
          "box-shadow:none", "pointer-events:none", "user-select:none"
        ].join(";");
        root.appendChild(badge);
        this.badge = badge;
      }
      this.target = target;
      const data = displayFor(selected.id, this.plan, this.stats, this.quota, this.now());
      // Show only a compact "(15)" within the Pro button. Preserve the
      // source category as internal diagnostic metadata, without a tooltip
      // or additional focusable UI.
      const compact = data.text.replace(/^剩余\s*/, "").replace(/^≈/, "");
      const text = "(" + compact + ")";
      if (this.badge.textContent !== text) this.badge.textContent = text;
      // Users do not need an explanation bubble or a focusable badge.
      // The estimate/limit source stays as internal metadata, not a tooltip.
      this.badge.removeAttribute?.("title");
      this.badge.removeAttribute?.("aria-label");
      if (this.badge.getAttribute("data-aih-pro-source") !== data.kind) {
        this.badge.setAttribute("data-aih-pro-source", data.kind);
      }
      this.position(target);
      this.mark("shown");
    }
  }

  namespace.ProModelBadge = ProModelBadge;
  namespace.proBadgeModel = { displayFor, proLabelRect };
  // A module marker lets page-world DevTools distinguish "not installed" from
  // "content script loaded but disabled or unable to find the Pro control".
  // Never expose prompt text, identifiers, quota details or settings values.
  if (namespace.proQuotaModel?.isChatGPT(globalThis.location?.hostname)) {
    const doc = globalThis.document;
    const stamp = () => {
      const root = doc?.documentElement;
      if (root && !root.hasAttribute("data-aih-pro-state")) {
        root.setAttribute("data-aih-pro-state", "module-loaded");
      }
    };
    if (doc?.documentElement) stamp();
    else doc?.addEventListener?.("DOMContentLoaded", stamp, { once: true });
  }
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
