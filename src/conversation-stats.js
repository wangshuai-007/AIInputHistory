(function initializeConversationStats(namespace) {
  "use strict";

  const SCHEMA_VERSION = 2;

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

  function safeCount(value) {
    const count = Number(value);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function sanitizeCountMap(value) {
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value)
      .filter(([key, count]) => key.length <= 16 && Number.isFinite(Number(count)) && Number(count) > 0)
      .map(([key, count]) => [key, Math.floor(Number(count))]));
  }

  function initialStats() {
    return { version: SCHEMA_VERSION, byAi: {} };
  }

  function sanitizeStats(value) {
    const source = value && typeof value === "object" ? value : {};
    if (source.version !== SCHEMA_VERSION) return initialStats();
    const result = initialStats();
    const byAi = source.byAi && typeof source.byAi === "object" ? source.byAi : {};
    for (const [aiKey, rawBucket] of Object.entries(byAi)) {
      if (!/^[a-z0-9:._-]{1,120}$/i.test(aiKey) || !rawBucket || typeof rawBucket !== "object") continue;
      result.byAi[aiKey] = {
        site: String(rawBucket.site || "").slice(0, 255),
        total: safeCount(rawBucket.total),
        days: sanitizeCountMap(rawBucket.days),
        weeks: sanitizeCountMap(rawBucket.weeks),
        months: sanitizeCountMap(rawBucket.months)
      };
    }
    return result;
  }

  function summarize(stats, now = Date.now()) {
    const clean = sanitizeStats(stats);
    const current = periodKeys(now);
    const rows = Object.entries(clean.byAi).map(([aiKey, bucket]) => ({
      aiKey,
      site: bucket.site,
      total: bucket.total,
      today: bucket.days[current.day] || 0,
      thisWeek: bucket.weeks[current.week] || 0,
      thisMonth: bucket.months[current.month] || 0
    }));
    rows.sort((left, right) => right.total - left.total || left.aiKey.localeCompare(right.aiKey));
    const all = rows.reduce((result, row) => ({
      total: result.total + row.total,
      today: result.today + row.today,
      thisWeek: result.thisWeek + row.thisWeek,
      thisMonth: result.thisMonth + row.thisMonth
    }), { total: 0, today: 0, thisWeek: 0, thisMonth: 0 });
    return { all, rows };
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  namespace.conversationStatsModel = {
    SCHEMA_VERSION,
    aiKeyForSite,
    initialStats,
    localDayKey,
    localMonthKey,
    localWeekKey,
    periodKeys,
    sanitizeStats,
    summarize
  };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
