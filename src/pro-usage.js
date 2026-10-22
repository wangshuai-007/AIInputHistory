(function initializeProUsage(namespace) {
  "use strict";

  const MODEL_LABELS = Object.freeze({
    "gpt-6-pro": "GPT-6 Pro",
    "gpt-5.6-pro": "GPT-5.6 Sol Pro",
    "pro": "Pro"
  });

  function classifyModelLabel(value) {
    // New ChatGPT composer pills may render their dropdown caret as TEXT
    // (e.g. "Pro⌄" or "Pro▾"), not an SVG. Treat just those decorative
    // arrow glyphs as separators; never treat plan/upgrade labels as models.
    const label = String(value || "")
      .replace(/[⌄⌃▾▿▼▽⏷˅ˇ∨↓]/g, " ")
      .replace(/\s+/g, " ").trim();
    if (!label || label.length > 110) return null;
    if (/(\bupgrade\b|\bsubscription\b|\bplan\b|\baccount\b|升级|订阅|套餐|账户)/i.test(label)) return null;
    if (/\b(?:instant|thinking|medium|high|extra high)\b/i.test(label) && !/\bgpt[\s-]*[\d.]+\s+(?:sol\s+)?pro\b/i.test(label)) return null;
    if (!/(?:^|[\s:;,-])pro(?:$|[\s:;,-])/i.test(label) && !/(?:^|[\s(:])(?:gpt[\s-]*)?\d+(?:\.\d+)?\s*pro\b/i.test(label)) return null;
    // Check 5.6 first: a naive 6Pro match also matches the tail of 5.6Pro.
    if (/\b(?:gpt[\s-]*)?5\.6\s*pro\b/i.test(label)
      || /\bgpt[\s-]*5\.6\b/i.test(label)) return "gpt-5.6-pro";
    if (/\b(?:gpt[\s-]*)?6(?:\.\d+)?\s*pro\b/i.test(label)
      || /\bgpt[\s-]*6(?:\.\d+)?\b/i.test(label)) return "gpt-6-pro";
    return "pro";
  }

  // Only currently selected model or effort controls are evidence. In particular,
  // the user's paid plan badge and *unselected* Pro menu options are not evidence.
  const SELECTORS = [
    // 2026 ChatGPT uses a composer-side Radix model/effort pill, often
    // without a data-testid or an aria-label; the old header selector is gone.
    'button.__composer-pill',
    'button[class*="composer-pill"]',
    'button[data-testid="model-switcher-dropdown-button"]',
    'button[data-testid="model-selector"]',
    'button[data-testid="model-picker-button"]',
    'button[data-testid*="model-switcher"]',
    'button[data-testid*="model-picker"]',
    'button[data-testid*="reasoning-effort"]',
    'button[data-testid*="thinking-effort"]',
    'button[aria-label^="Model:"]',
    'button[aria-label^="Current model:"]',
    'button[aria-label^="模型："]',
    '[data-testid*="model"][role="menuitemradio"][aria-checked="true"]',
    '[data-testid*="model"][role="option"][aria-selected="true"]'
  ].join(",");

  function visible(element) {
    if (element.closest?.('[hidden],[inert],[aria-hidden="true"],[data-ai-input-history]')) return false;
    if (typeof element.getClientRects === "function" && !element.getClientRects().length) return false;
    return true;
  }

  const COMPOSER_EDITOR_SELECTOR = [
    'form[data-chatgpt-composer] [contenteditable="true"]',
    'form[data-chatgpt-composer] textarea',
    'form [contenteditable="true"][role="textbox"]',
    'form textarea',
    '[data-testid="composer"] [contenteditable="true"]',
    '[data-testid="composer"] textarea',
    '[data-composer-markdown][contenteditable="true"]',
    '[contenteditable="true"][class*="ProseMirror"]',
    '[contenteditable="true"][role="textbox"]',
    'textarea[class*="composer"]',
    'textarea[data-testid*="prompt"]',
    '#prompt-textarea',
    '[contenteditable="plaintext-only"]',
    '[data-placeholder][contenteditable="true"]'
  ].join(",");

  const COMPOSER_ACTION_SELECTOR = [
    'button[data-testid="send-button"]',
    'button[data-testid="stop-button"]',
    '#composer-submit-button',
    'button[data-testid*="composer-submit"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Send message"]'
  ].join(",");

  // ChatGPT includes aria-hidden measuring strings such as "Thinking effort"
  // inside the Pro dropdown. textContent merges those hidden strings into
  // "Thinking effortPro", which the strict model classifier correctly rejects.
  // innerText reflects what the user actually sees; fallback only for DOM
  // mocks / environments without innerText.
  function modelControlText(node) {
    return typeof node?.innerText === "string" ? node.innerText : node?.textContent;
  }

  function detectComposerModel(doc) {
    // In current ChatGPT, the model chip often sits in a footer SIBLING of
    // the editor's <form>. Restricting lookup to editor.closest("form") makes
    // a visible "Pro" impossible to find. Walk a few bounded ancestors until
    // both the editor and its adjacent toolbar are in scope. Never scan the
    // transcript, site navigation, hidden model menus or subscription upsells.
    const anchors = [...new Set([
      ...doc.querySelectorAll(COMPOSER_EDITOR_SELECTOR),
      ...doc.querySelectorAll(COMPOSER_ACTION_SELECTOR)
    ])].filter((element) => visible(element));
    const CONTROL_SELECTOR = 'button,[role="button"],[role="combobox"],[aria-haspopup="menu"],[aria-haspopup="listbox"]';
    const MENU_SELECTOR = '[role="menu"],[role="listbox"],[data-ai-input-history],header,nav,aside,[data-message-author-role],[data-turn-key],[data-turn]';
    for (const editor of anchors) {
      const editorRect = editor.getBoundingClientRect?.();
      let container = editor.parentElement;
      for (let depth = 0; container && depth < 8; depth++, container = container.parentElement) {
        if (container === doc.body || container === doc.documentElement
          || /^(?:MAIN|ARTICLE|ASIDE|NAV|HEADER)$/i.test(container.tagName || "")) break;
        const controls = [...(container.querySelectorAll?.(CONTROL_SELECTOR) || [])];
        // Do not broaden this into a scan of all conversation actions.
        if (controls.length > 28) break;
        for (const button of controls) {
          if (!visible(button) || button.closest?.(MENU_SELECTOR)) continue;
          const rect = button.getBoundingClientRect?.();
          if (editorRect && rect && editorRect.width > 0 && rect.width > 0) {
            const gapX = Math.max(0, editorRect.left - rect.right,
              rect.left - editorRect.right);
            const gapY = Math.max(0, editorRect.top - rect.bottom,
              rect.top - editorRect.bottom);
            if (gapX > 220 || gapY > 160) continue;
          }
          const labels = [
            button.getAttribute?.("data-model-label"),
            button.getAttribute?.("title"),
            modelControlText(button),
            button.getAttribute?.("aria-label")
          ];
          for (const label of labels) {
            // A selected model chip has a short label. Parsing entire toolbars,
            // transcript messages or hidden menu options would cause overcount.
            if (typeof label !== "string" || label.trim().length > 35) continue;
            const id = classifyModelLabel(label);
            if (id) return {
              id, evidence: "composer-pro-control", element: button
            };
          }
        }
      }
    }
    return detectNearbyComposerModel(doc, anchors);
  }

  /** Find composer-adjacent Pro even when its toolbar is portal-rendered.
   * ChatGPT can put the visible right-hand mode pill in a sibling React root,
   * beyond the bounded 8-level ancestor walk above. Only a short Pro-labelled
   * interactive control next to a visible editor/send action is considered.
   * Never use offscreen text, navigation, chat turns or open model menus.
   */
  function detectNearbyComposerModel(doc, anchors) {
    if (!anchors.length || !doc?.querySelectorAll) return null;
    const rects = anchors.map((anchor) => anchor.getBoundingClientRect?.())
      .filter((rect) => rect && rect.width > 0 && rect.height > 0);
    if (!rects.length) return null;
    const CONTROL_SELECTOR = 'button,[role="button"],[role="combobox"],[aria-haspopup="menu"],[aria-haspopup="listbox"]';
    const EXCLUDE = '[role="menu"],[role="listbox"],[role="dialog"],[data-ai-input-history],header,nav,aside,[data-message-author-role],[data-turn-key],[data-turn]';
    const all = [...doc.querySelectorAll(CONTROL_SELECTOR)];
    // A long conversation can have thousands of transcript buttons. The
    // composer controls are normally at the end of the document.
    const controls = all.length > 1250 ? [
      ...all.slice(0, 100), ...all.slice(-1150)
    ] : all;
    let best = null;
    for (const button of controls) {
      if (button.closest?.(EXCLUDE)) continue;
      // Most page buttons aren't model controls. Avoid expensive layout
      // visibility checks for non-Pro buttons in long conversations.
      const labels = [button.getAttribute?.("data-model-label"),
        button.getAttribute?.("title"), modelControlText(button),
        button.getAttribute?.("aria-label")];
      let id = null;
      for (const label of labels) {
        if (typeof label !== "string" || label.trim().length > 35) continue;
        id = classifyModelLabel(label);
        if (id) break;
      }
      if (!id || !visible(button)) continue;
      const rect = button.getBoundingClientRect?.();
      if (!rect || rect.width < 8 || rect.height < 8) continue;
      for (const anchor of rects) {
        const dx = Math.max(0, anchor.left - rect.right,
          rect.left - anchor.right);
        const dy = Math.max(0, anchor.top - rect.bottom,
          rect.top - anchor.bottom);
        if (dx > 240 || dy > 170) continue;
        const distance = dx + dy * 2;
        if (!best || distance < best.distance) {
          best = { id, evidence: "composer-nearby-control", element: button, distance };
        }
      }
    }
    return best ? {
      id: best.id, evidence: best.evidence, element: best.element
    } : null;
  }

  function detect(doc = globalThis.document, { composerOnly = false } = {}) {
    if (!doc?.querySelectorAll) return null;
    // Open model menus can contain a selected Pro option that is NOT the
    // composer button. Prefer the visible Pro control beside the editor, so
    // its badge always follows the actual selection rather than a popover.
    const candidates = [...doc.querySelectorAll(SELECTORS)].filter((node) =>
      visible(node) && !node.closest?.('[role="menu"],[role="listbox"],[role="dialog"]'));
    const modelButtons = candidates.filter((node) =>
      !/effort/i.test(node.getAttribute?.("data-testid") || ""));
    const versionLabel = modelButtons.map((node) =>
      [node.getAttribute?.("aria-label"), node.getAttribute?.("title"), modelControlText(node)]
        .filter(Boolean).join(" ")).find((label) => /\bgpt[\s-]*\d/i.test(label)) || "";
    const local = detectComposerModel(doc);
    if (local) {
      const identified = local.id === "pro"
        ? classifyModelLabel(versionLabel + " Pro") : null;
      return identified ? { ...local, id: identified } : local;
    }
    // Badges belong to the composer only, never to a header fallback.
    if (composerOnly) return null;
    for (const node of candidates) {
      const attrs = [node.getAttribute?.("aria-label"), node.getAttribute?.("title"), modelControlText(node)];
      for (const label of attrs) {
        const id = classifyModelLabel(label);
        if (!id) continue;
        const identified = id === "pro" ? classifyModelLabel(versionLabel + " Pro") : id;
        return { id: identified || id, evidence: "model-picker", element: node };
      }
    }
    return null;
  }

  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

  function localDay(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")].join("-");
  }

  function periodSeries(raw, period, now, length) {
    const anchor = new Date(now);
    anchor.setHours(12, 0, 0, 0); // DST-safe calendar arithmetic
    if (period === "week") {
      anchor.setDate(anchor.getDate() - (anchor.getDay() || 7) + 1);
    } else if (period === "month") anchor.setDate(1);
    return Array.from({ length }, (_, index) => {
      const date = new Date(anchor.getTime());
      const back = length - 1 - index;
      if (period === "day") date.setDate(date.getDate() - back);
      else if (period === "week") date.setDate(date.getDate() - back * 7);
      else date.setMonth(date.getMonth() - back);
      const key = period === "month" ? localDay(date).slice(0, 7) : localDay(date);
      const mapKey = period === "day" ? "days" : period === "week" ? "weeks" : "months";
      const models = Object.fromEntries(Object.keys(MODEL_LABELS).map((id) =>
        [id, count(raw.models?.[id]?.[mapKey]?.[key])]));
      return { key, total: Object.values(models).reduce((sum, n) => sum + n, 0), models };
    });
  }

  function summarize(value, now = Date.now()) {
    const raw = value && typeof value === "object" ? value : {};
    const periods = namespace.conversationStatsModel?.periodKeys(now) || {};
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = localDay(yesterday);
    const daily = periodSeries(raw, "day", now, 14);
    const rows = Object.entries(MODEL_LABELS).map(([id, label]) => {
      const bucket = raw.models?.[id] || {};
      return {
        id, label, total: count(bucket.total),
        today: count(bucket.days?.[periods.day]), yesterday: count(bucket.days?.[yesterdayKey]),
        thisWeek: count(bucket.weeks?.[periods.week]),
        thisMonth: count(bucket.months?.[periods.month])
      };
    }).filter((row) => row.total > 0);
    const all = rows.reduce((acc, row) => {
      for (const key of ["total", "today", "yesterday", "thisWeek", "thisMonth"]) acc[key] += row[key];
      return acc;
    }, { total: 0, today: 0, yesterday: 0, thisWeek: 0, thisMonth: 0 });
    // Last 7 calendar days (including today) differs from the Monday-based week.
    all.last7Days = daily.slice(-7).reduce((sum, day) => sum + day.total, 0);
    return {
      all, rows, resetAt: Number.isFinite(raw.monthResetAt) ? raw.monthResetAt
        : Number.isFinite(raw.resetAt) ? raw.resetAt : null,
      periods: {
        day: daily,
        week: periodSeries(raw, "week", now, 8),
        month: periodSeries(raw, "month", now, 12)
      }
    };
  }

  const PLAN_LABELS = Object.freeze({
    unknown: "未确认",
    "pro-100": "Pro $100",
    "pro-200": "Pro $200",
    "pro-500": "Pro $500（额度未确认）",
    "pro-unverified": "Pro（档位未确认）",
    "business-unverified": "Business（档位未确认）",
    plus: "Plus",
    go: "Go",
    free: "Free",
    "business-standard": "Business Standard",
    "business-premium": "Business Premium",
    enterprise: "Enterprise / 自定义"
  });

  /**
   * Read only subscription classification fields from /api/auth/session.
   * Never pass the whole session, user identifiers or access tokens to popup.
   * Generic "pro" and "business" cannot distinguish the pricing tier.
   */
  function classifyAccountPlan(session) {
    const account = session?.account;
    const candidates = [
      account?.planType, account?.plan_type, account?.subscription?.planType,
      account?.subscription?.plan_type, session?.planType, session?.plan_type
    ];
    const raw = candidates.find((item) => typeof item === "string"
      && item.trim() && item.length < 75);
    if (!raw) return { plan: "unknown", type: "unknown", precise: false };
    const type = raw.toLowerCase().trim().replace(/[\s_]+/g, "-");
    const compact = type.replace(/-/g, "");
    const exact = {
      pro100: "pro-100", pro200: "pro-200", pro500: "pro-500",
      businessstandard: "business-standard", businesspremium: "business-premium"
    };
    if (exact[compact]) return { plan: exact[compact], type, precise: true };
    if (/^(?:pro(?:-tier)?|prolite|pro-lite|pro5x|pro-5x)$/.test(type)) {
      return { plan: "pro-unverified", type, precise: false };
    }
    if (/^(business|team)$/.test(type)) return {
      plan: "business-unverified", type: "business", precise: false
    };
    if (["plus", "free", "go", "enterprise"].includes(type)) return {
      plan: type, type, precise: true
    };
    return { plan: "unknown", type: "unrecognized", precise: false };
  }

  function classifyAccountList(data, session) {
    const accounts = data?.accounts;
    if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
      return { plan: "unknown", type: "unknown", precise: false, reason: "accounts-format-unknown" };
    }
    const choices = Object.entries(accounts).filter(([, row]) =>
      row?.account && row.account.is_deactivated !== true);
    if (!choices.length) {
      return { plan: "unknown", type: "unknown", precise: false, reason: "accounts-empty" };
    }
    const currentIds = [
      data?.active_account_id, data?.selected_account_id, data?.current_account_id,
      session?.account?.workspaceId, session?.account?.workspace_id,
      session?.account?.id, session?.account?.accountId, session?.account?.account_id
    ].filter((id) => typeof id === "string" && id.length > 0);
    let selected = currentIds.map((id) => choices.find(([key, row]) =>
      id === key || id === row.account?.account_id || id === row.account?.id
    )).find(Boolean);
    if (!selected) {
      const active = choices.filter(([, row]) => row.account?.is_active === true
        || row.account?.is_selected === true || row.is_active === true);
      if (active.length === 1) selected = active[0];
    }
    if (!selected && choices.length === 1) selected = choices[0];
    if (selected) {
      const row = selected[1];
      return classifyAccountPlan({ account: {
        planType: row.account?.plan_type || row.account?.planType
          || row.entitlement?.plan_type
      } });
    }
    const unique = new Map();
    for (const [, row] of choices) {
      const result = classifyAccountPlan({ account: {
        planType: row.account?.plan_type || row.account?.planType
      } });
      if (result.plan === "unknown") {
        return { ...result, reason: "accounts-multiple-ambiguous" };
      }
      unique.set(result.plan, result);
    }
    if (unique.size === 1) return [...unique.values()][0];
    return {
      plan: "unknown", type: "unknown", precise: false,
      reason: "accounts-multiple-ambiguous"
    };
  }

  // A Business member's seat_type="default" is a legacy regular ChatGPT
  // seat (rather than "usage_based"). Map it to the modern Standard tier as
  // a COMPATIBILITY ALIAS, not an officially verified seat migration.
  // Never infer a member's seat from the workspace's default_seat_type.
  function classifyBusinessSeat(value) {
    const kind = typeof value === "string"
      ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    const types = {
      default: "business-standard", standard: "business-standard",
      chatgpt_standard: "business-standard",
      standard_chatgpt: "business-standard",
      premium: "business-premium", chatgpt_premium: "business-premium",
      premium_chatgpt: "business-premium"
    };
    return Object.hasOwn(types, kind) ? types[kind] : null;
  }

  function currentAccountEntry(data, session) {
    if (!data?.accounts || typeof data.accounts !== "object"
      || Array.isArray(data.accounts)) return null;
    const accounts = Object.entries(data.accounts).filter(([, value]) =>
      value?.account && value.account.is_deactivated !== true);
    const ids = [
      data.selected_account_id, data.active_account_id, data.current_account_id,
      session?.account?.workspaceId, session?.account?.workspace_id,
      session?.account?.id, session?.account?.accountId, session?.account?.account_id
    ].filter((id) => typeof id === "string" && id.length);
    for (const id of ids) {
      const found = accounts.find(([key, row]) => key === id
        || row.account.account_id === id || row.account.id === id);
      if (found) return { id: found[0], row: found[1] };
    }
    const active = accounts.filter(([, row]) => row.account?.is_active === true
      || row.account?.is_selected === true || row.is_active === true);
    if (active.length === 1) return { id: active[0][0], row: active[0][1] };
    if (accounts.length === 1) return { id: accounts[0][0], row: accounts[0][1] };
    return null;
  }

  /**
   * Record only the matched member's SAFE seat schema/enum. This is also used
   * to diagnose future ChatGPT API field changes, without storing raw JSON,
   * member emails, user IDs, role names, cookies or access tokens.
   */
  function inspectOwnSeatFromMembers(data, session, accountId) {
    const items = Array.isArray(data?.items) ? data.items : [];
    const userIds = [session?.user?.id, session?.user?.user_id,
      session?.account?.user_id, session?.account?.userId]
      .filter((id) => typeof id === "string" && id.length);
    const email = typeof session?.user?.email === "string"
      ? session.user.email.trim().toLowerCase() : "";
    const own = items.map((item) => {
      if (!item || typeof item !== "object") return null;
      const ids = [item.id, item.user_id, item.user?.id];
      if (userIds.some((id) => ids.includes(id))) return { item, matchedBy: "user-id" };
      if (typeof item.account_user_id === "string"
        && userIds.some((id) => item.account_user_id === id + "__" + accountId)) {
        return { item, matchedBy: "account-user-id" };
      }
      if (email && typeof item.email === "string"
        && item.email.trim().toLowerCase() === email) return { item, matchedBy: "email" };
      return null;
    }).filter(Boolean);
    if (own.length !== 1) return null;

    const { item, matchedBy } = own[0];
    const fields = [
      ["seat_type", item.seat_type], ["seatType", item.seatType],
      ["seat.type", item.seat?.type],
      ["user.seat_type", item.user?.seat_type],
      ["membership.seat_type", item.membership?.seat_type],
      ["account_user.seat_type", item.account_user?.seat_type],
      ["entitlement.seat_type", item.entitlement?.seat_type]
    ];
    const selected = fields.find(([, value]) => value !== undefined && value !== null);
    const value = selected?.[1];
    const valueKind = value === undefined ? "missing" : value === null ? "null"
      : Array.isArray(value) ? "array" : typeof value;
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    const seatTypeCode = valueKind === "string"
      ? (/^[a-z][a-z0-9_-]{0,39}$/.test(normalized)
        && !/(?:secret|token|bearer|auth|session|password|api_?key)/i.test(normalized)
        && !/^[a-f0-9]{24,}$/i.test(normalized)
        ? normalized : "(non-enum-string)")
      : "(" + valueKind + ")";
    const seatFieldKeys = Object.keys(item)
      .filter((name) => /seat|entitl|member|subscription/i.test(name)
        && /^[a-z][a-z0-9_]{0,39}$/i.test(name))
      .slice(0, 8).join(",") || "(none)";
    return {
      // This is the ONLY raw value. readBusinessSeat() never returns it.
      rawSeat: value,
      plan: classifyBusinessSeat(value),
      seatMapping: normalized === "default" ? "legacy-default-as-standard" : null,
      seatTypeCode, seatField: selected?.[0] || "(missing)",
      seatValueKind: valueKind, seatMatchedBy: matchedBy, seatFieldKeys,
      seatRecordCount: Math.min(items.length, 1000)
    };
  }

  function selectOwnSeatFromMembers(data, session, accountId) {
    return inspectOwnSeatFromMembers(data, session, accountId)?.plan || null;
  }

  async function readBusinessSeat({ data, session, fetcher }) {
    const selected = currentAccountEntry(data, session);
    if (!selected || !/^[a-z0-9_-]{8,150}$/i.test(selected.id)) {
      return { plan: null, reason: "seat-account-unresolved" };
    }
    const ownSeat = selected.row?.user?.seat_type
      || selected.row?.account_user?.seat_type
      || selected.row?.membership?.seat_type
      || selected.row?.account?.current_user?.seat_type;
    const directly = classifyBusinessSeat(ownSeat);
    const directAlias = typeof ownSeat === "string"
      && ownSeat.trim().toLowerCase() === "default";
    // Explicit Standard/Premium direct fields are authoritative. A legacy
    // default alias stays provisional until we check the exact member record;
    // its modern seat_type may already be Premium.
    if (directly && !directAlias) return { plan: directly, source: "chatgpt-member-seat" };
    const legacyFallback = directAlias ? {
      plan: "business-standard", source: "chatgpt-member-seat",
      seatMapping: "legacy-default-as-standard", seatTypeCode: "default"
    } : null;
    if (!session?.user?.id && !session?.user?.user_id
      && !session?.user?.email && !session?.account?.user_id) {
      return legacyFallback || { plan: null, reason: "seat-user-unresolved" };
    }
    const base = "/backend-api/accounts/" + encodeURIComponent(selected.id) + "/users";
    const headers = { ...fetchPlanOptions(session.accessToken).headers,
      "ChatGPT-Account-ID": selected.id };
    const email = typeof session.user?.email === "string"
      ? session.user.email.trim() : "";
    const searches = email.length <= 254 && email
      ? [email, ""] : [""];
    let reason = "seat-match-not-found";
    for (const query of searches) {
      const requestedLimit = query ? 25 : 100;
      let offset = 0;
      const maxRecords = query ? 25 : 300;
      while (offset < maxRecords) {
        let response;
        try {
          response = await fetcher(base + "?offset=" + offset
            + "&limit=" + requestedLimit + "&query=" + encodeURIComponent(query), {
            ...fetchPlanOptions(session.accessToken), headers
          });
        } catch {
          return { plan: null, reason: "seat-fetch-failed" };
        }
        if (!response?.ok) {
          return { plan: null, reason: "seat-http-" + (response?.status || "unknown") };
        }
        let members;
        try { members = await response.json(); }
        catch { return { plan: null, reason: "seat-non-json" }; }
        const seat = inspectOwnSeatFromMembers(members, session, selected.id);
        if (seat) {
          // Allowlist only schema/enum metadata. Never return the matched
          // member record, rawSeat, identity, or other response fields.
          const { seatTypeCode, seatField, seatValueKind, seatMatchedBy,
            seatFieldKeys, seatRecordCount } = seat;
          const diagnostic = {
            seatTypeCode, seatField, seatValueKind, seatMatchedBy,
            seatFieldKeys, seatRecordCount
          };
          if (seat.plan) return {
            plan: seat.plan, source: "chatgpt-member-seat",
            seatMapping: seat.seatMapping || null, ...diagnostic
          };
          return { plan: null, reason: "seat-type-unrecognized", ...diagnostic };
        }
        const rows = Array.isArray(members?.items) ? members.items : [];
        // Servers may clamp limit=100 to 25. Advance by the actual returned
        // page size to avoid skipping members in large Business workspaces.
        const pageSize = Number.isSafeInteger(members?.limit) && members.limit > 0
          ? Math.min(members.limit, requestedLimit) : rows.length;
        if (!rows.length || !pageSize || rows.length < pageSize) break;
        offset += rows.length;
        if (Number.isFinite(members?.total) && offset >= members.total) break;
      }
    }
    return legacyFallback || { plan: null, reason };
  }

  function fetchPlanOptions(token) {
    const headers = { Accept: "application/json" };
    // Only ever send this in-memory token back to the SAME ChatGPT origin.
    if (typeof token === "string" && token.length > 20 && token.length < 8000) {
      headers.Authorization = "Bearer " + token;
    }
    return {
      method: "GET", credentials: "same-origin", cache: "no-store", headers,
      ...(typeof AbortSignal !== "undefined" && AbortSignal.timeout
        ? { signal: AbortSignal.timeout(8000) } : {})
    };
  }

  async function readCurrentAccountPlan({ fetcher = globalThis.fetch } = {}) {
    // Only the classified plan/type leaves this function. Raw JSON, workspace
    // IDs, email and accessToken are never returned or persisted.
    let session;
    let sessionError = null;
    try {
      const response = await fetcher("/api/auth/session", fetchPlanOptions());
      if (!response?.ok) {
        sessionError = "session-http-" + (response?.status || "unknown");
      } else {
        try { session = await response.json(); }
        catch { sessionError = "session-non-json"; }
      }
    } catch {
      sessionError = "session-fetch-failed";
    }
    const direct = classifyAccountPlan(session);

    // Prefer the currently selected ChatGPT workspace to session planType:
    // sessions can show a personal Plus/Pro seat while Business is active.
    let accountData = null;
    let listed = null;
    let accountError = null;
    try {
      const response = await fetcher(
        "/backend-api/accounts/check/v4-2023-04-27",
        fetchPlanOptions(session?.accessToken)
      );
      if (!response?.ok) accountError = "accounts-http-" + (response?.status || "unknown");
      else {
        try {
          accountData = await response.json();
          listed = classifyAccountList(accountData, session);
        } catch { accountError = "accounts-non-json"; }
      }
    } catch {
      accountError = "accounts-fetch-failed";
    }
    const selected = currentAccountEntry(accountData, session);
    const selectedPlan = selected && classifyAccountPlan({ account: {
      planType: selected.row.account?.plan_type || selected.row.account?.planType
        || selected.row.entitlement?.plan_type
    } });
    const hasSelectedPlan = selectedPlan && selectedPlan.plan !== "unknown";
    const effective = hasSelectedPlan ? selectedPlan
      : listed?.plan && listed.plan !== "unknown" && (direct.plan === "unknown"
        || listed.precise || listed.plan === direct.plan) ? listed : direct;
    const source = hasSelectedPlan || effective === listed
      ? "chatgpt-account-list" : "chatgpt-session";

    if (effective.plan === "business-unverified") {
      const seat = accountData
        ? await readBusinessSeat({ data: accountData, session, fetcher })
        : { plan: null, reason: accountError || "seat-account-unresolved" };
      const { seatTypeCode, seatField, seatValueKind, seatMatchedBy,
        seatFieldKeys, seatRecordCount } = seat;
      const seatDiagnostic = { seatTypeCode, seatField, seatValueKind,
        seatMatchedBy, seatFieldKeys, seatRecordCount,
        seatMapping: seat.seatMapping || null };
      if (seat.plan) return {
        ok: true, plan: seat.plan, type: "business",
        precise: seat.seatMapping !== "legacy-default-as-standard",
        source: seat.source, ...seatDiagnostic
      };
      return {
        ok: true, plan: "business-unverified", type: "business",
        precise: false, source, seatReason: seat.reason || "seat-type-unrecognized",
        ...seatDiagnostic
      };
    }
    if (effective.plan !== "unknown") {
      return { ok: true, plan: effective.plan, type: effective.type,
        precise: effective.precise, source };
    }
    return {
      ok: false, reason: listed?.reason || sessionError || accountError || "plan-not-present"
    };
  }

  // A monthly display is a local accounting view, not a monthly allowance
  // for subscriptions that actually reset daily or weekly.
  function allowanceOverview({ plan = "unknown", stats, now = Date.now() } = {}) {
    const summary = stats?.all && Array.isArray(stats?.rows) ? stats : summarize(stats, now);
    const usedThisMonth = summary.all.thisMonth;
    const current = {
      "pro-100": { cap: 50, period: "week", shared: true },
      "pro-200": { cap: 200, period: "week-and-day", shared: false },
      "business-standard": { cap: 15, period: "month", shared: true },
      "business-premium": { cap: 50, period: "week", shared: true }
    }[plan] || null;
    const remaining = current?.period === "month"
      ? Math.max(0, current.cap - usedThisMonth) : null;
    return {
      usedThisMonth, monthlyCap: current?.period === "month" ? current.cap : null,
      monthlyRemaining: remaining, period: current?.period || "unknown",
      weeklyOrDaily: current?.period === "week" || current?.period === "week-and-day",
      planLabel: PLAN_LABELS[plan] || PLAN_LABELS.unknown
    };
  }

  function remainingEstimate({ plan = "unknown", modelId, stats, now = Date.now() } = {}) {
    if (!Object.hasOwn(PLAN_LABELS, plan) || plan === "unknown" || plan === "enterprise") return null;
    const counts = stats?.all && Array.isArray(stats?.rows) ? stats : summarize(stats, now);
    const usage = (id, field) => count(counts.rows.find((row) => row.id === id)?.[field]);
    const shared = (field) => counts.rows.reduce((total, row) => total + count(row[field]), 0);
    const estimated = (cap, used, period, constraint) => ({
      remaining: Math.max(0, cap - used),
      cap, used, period, constraint, kind: "local-estimate"
    });
    if (plan === "pro-100") return estimated(50, shared("thisWeek"), "week", "shared");
    if (plan === "business-standard") return estimated(15, shared("thisMonth"), "month", "shared");
    if (plan === "business-premium") return estimated(50, shared("thisWeek"), "week", "shared");
    if (plan === "pro-200") {
      // The two distinct Pro models have separate windows, but both contribute
      // to the 200/day combined cap. Ambiguous Pro labels are conservatively
      // subtracted from either possible model-specific window.
      const dailyCombined = estimated(200, shared("today"), "day", "combined");
      if (modelId === "gpt-6-pro") {
        const weekly = estimated(200, usage("gpt-6-pro", "thisWeek") + usage("pro", "thisWeek"), "week", "gpt6");
        return weekly.remaining <= dailyCombined.remaining ? weekly : dailyCombined;
      }
      if (modelId === "gpt-5.6-pro") {
        const daily = estimated(170, usage("gpt-5.6-pro", "today") + usage("pro", "today"), "day", "gpt5.6");
        return daily.remaining <= dailyCombined.remaining ? daily : dailyCombined;
      }
    }
    return null;
  }

  namespace.proUsageModel = {
    MODEL_LABELS, PLAN_LABELS, SELECTORS,
    COMPOSER_EDITOR_SELECTOR, COMPOSER_ACTION_SELECTOR,
    classifyModelLabel, detect, detectComposerModel,
    summarize, remainingEstimate, classifyAccountPlan, classifyAccountList,
    classifyBusinessSeat, readCurrentAccountPlan, allowanceOverview
  };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
