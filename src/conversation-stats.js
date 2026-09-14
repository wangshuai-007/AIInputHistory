(function initializeConversationStats(namespace) {
  "use strict";

  const GENERIC_PATHS = new Set(["/", "/new", "/chat", "/app", "/search", "/ask", "/home", "/new-chat"]);

  function normalizeSite(site) {
    return String(site || "").toLocaleLowerCase().replace(/^www\./, "");
  }

  function aiKeyForSite(site) {
    const hostname = normalizeSite(site);
    const profile = namespace.SiteProfiles?.forSite(hostname);
    return profile?.id || `custom:${hostname}`;
  }

  function localDayKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function localMonthKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  }

  function localWeekKey(timestamp) {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    const day = date.getDay() || 7;
    date.setDate(date.getDate() - day + 1);
    return localDayKey(date.getTime());
  }

  function periodKeys(timestamp) {
    const value = Number.isFinite(timestamp) ? timestamp : Date.now();
    return { day: localDayKey(value), week: localWeekKey(value), month: localMonthKey(value) };
  }

  function resolveConversation(locationLike, pageSessionId) {
    const hostname = normalizeSite(locationLike?.hostname);
    const pathname = normalizePath(locationLike?.pathname);
    const search = selectConversationSearch(locationLike?.search);
    const hash = selectConversationHash(locationLike?.hash);
    const stable = isStableConversationPath(pathname) || Boolean(search || hash);
    const routeKey = `${hostname}${pathname}${search}${hash}`;
    return {
      stable,
      routeKey,
      key: stable ? routeKey : `${hostname}:page-session:${String(pageSessionId || "unknown")}`
    };
  }

  function normalizePath(value) {
    let path = String(value || "/").trim() || "/";
    if (!path.startsWith("/")) path = `/${path}`;
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  }

  function isStableConversationPath(pathname) {
    if (GENERIC_PATHS.has(pathname.toLocaleLowerCase())) return false;
    const segments = pathname.split("/").filter(Boolean);
    if (!segments.length) return false;
    return segments.some((segment) => /\d/.test(segment) || segment.length >= 12);
  }

  function selectConversationSearch(value) {
    const raw = String(value || "");
    if (!raw || raw === "?") return "";
    const params = new URLSearchParams(raw);
    const selected = [];
    for (const [key, item] of params.entries()) {
      if (/^(id|chat|chatid|conversation|conversationid|thread|threadid|session|sessionid)$/i.test(key) && item) {
        selected.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      }
    }
    return selected.length ? `?${selected.sort().join("&")}` : "";
  }

  function selectConversationHash(value) {
    const hash = String(value || "").trim();
    if (!hash || hash === "#") return "";
    const cleaned = hash.replace(/^#/, "");
    if (cleaned.length < 6) return "";
    return `#${cleaned.slice(0, 300)}`;
  }

  function fingerprint(value) {
    const text = String(value || "");
    let left = 2166136261;
    let right = 2246822507;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      left = Math.imul(left ^ code, 16777619);
      right = Math.imul(right ^ code, 3266489909);
    }
    return `${(left >>> 0).toString(36)}${(right >>> 0).toString(36)}`;
  }

  function initialStats() {
    return { version: 1, byAi: {} };
  }

  function sanitizeStats(value) {
    const source = value && typeof value === "object" ? value : {};
    const result = initialStats();
    const byAi = source.byAi && typeof source.byAi === "object" ? source.byAi : {};
    for (const [aiKey, rawBucket] of Object.entries(byAi)) {
      if (!/^[a-z0-9:._-]{1,120}$/i.test(aiKey) || !rawBucket || typeof rawBucket !== "object") continue;
      result.byAi[aiKey] = {
        site: String(rawBucket.site || "").slice(0, 255),
        total: safeCount(rawBucket.total),
        days: sanitizeCountMap(rawBucket.days),
        weeks: sanitizeCountMap(rawBucket.weeks),
        months: sanitizeCountMap(rawBucket.months),
        seen: sanitizeSeen(rawBucket.seen)
      };
    }
    return result;
  }

  function sanitizeCountMap(value) {
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([key, count]) => key.length <= 16 && Number.isFinite(Number(count)) && Number(count) > 0)
      .map(([key, count]) => [key, Math.floor(Number(count))]));
  }

  function sanitizeSeen(value) {
    if (!value || typeof value !== "object") return {};
    const result = {};
    for (const [key, raw] of Object.entries(value)) {
      if (key.length > 32) continue;
      if (Number.isFinite(Number(raw))) {
        const firstAt = Number(raw);
        const periods = periodKeys(firstAt);
        result[key] = { firstAt, lastDay: periods.day, lastWeek: periods.week, lastMonth: periods.month };
        continue;
      }
      if (!raw || typeof raw !== "object" || !Number.isFinite(Number(raw.firstAt))) continue;
      result[key] = {
        firstAt: Number(raw.firstAt),
        lastDay: String(raw.lastDay || "").slice(0, 16),
        lastWeek: String(raw.lastWeek || "").slice(0, 16),
        lastMonth: String(raw.lastMonth || "").slice(0, 16)
      };
    }
    return result;
  }

  function safeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function summarize(stats, now = Date.now()) {
    const clean = sanitizeStats(stats);
    const current = periodKeys(now);
    const rows = Object.entries(clean.byAi).map(([aiKey, bucket]) => summarizeBucket(aiKey, bucket, current));
    rows.sort((left, right) => right.total - left.total || left.aiKey.localeCompare(right.aiKey));
    return { all: summarizeAll(clean.byAi, current), rows };
  }

  function summarizeBucket(aiKey, bucket, current) {
    return {
      aiKey,
      site: bucket.site,
      total: bucket.total,
      today: bucket.days[current.day] || 0,
      thisWeek: bucket.weeks[current.week] || 0,
      thisMonth: bucket.months[current.month] || 0,
      activeDays: Object.keys(bucket.days).length,
      activeWeeks: Object.keys(bucket.weeks).length,
      activeMonths: Object.keys(bucket.months).length
    };
  }

  function summarizeAll(byAi, current) {
    const dayKeys = new Set();
    const weekKeys = new Set();
    const monthKeys = new Set();
    let total = 0, today = 0, thisWeek = 0, thisMonth = 0;
    Object.values(byAi).forEach((bucket) => {
      total += bucket.total;
      today += bucket.days[current.day] || 0;
      thisWeek += bucket.weeks[current.week] || 0;
      thisMonth += bucket.months[current.month] || 0;
      Object.keys(bucket.days).forEach((key) => dayKeys.add(key));
      Object.keys(bucket.weeks).forEach((key) => weekKeys.add(key));
      Object.keys(bucket.months).forEach((key) => monthKeys.add(key));
    });
    return { total, today, thisWeek, thisMonth, activeDays: dayKeys.size, activeWeeks: weekKeys.size, activeMonths: monthKeys.size };
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  namespace.conversationStatsModel = {
    aiKeyForSite,
    fingerprint,
    initialStats,
    localDayKey,
    localMonthKey,
    localWeekKey,
    periodKeys,
    resolveConversation,
    sanitizeStats,
    summarize
  };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
