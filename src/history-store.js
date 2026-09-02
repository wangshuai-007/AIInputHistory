(function initializeHistoryStore(namespace) {
  "use strict";

  const STORAGE_KEY = "aiInputHistoryState";
  const SETTINGS_KEY = "aiInputHistorySettings";
  const DEFAULT_SETTINGS = Object.freeze({
    historyLimit: 100,
    sendLimit: 10,
    snapshotSeconds: 60,
    shortcut: "Ctrl+R",
    launcherEnabled: true,
    customDomains: []
  });

  function sanitizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const snapshotSeconds = source.snapshotSeconds ?? (Number.parseInt(source.snapshotMinutes, 10) * 60 || DEFAULT_SETTINGS.snapshotSeconds);
    return {
      historyLimit: clampInteger(source.historyLimit, 20, 500, DEFAULT_SETTINGS.historyLimit),
      sendLimit: clampInteger(source.sendLimit ?? source.enterLimit, 1, 50, DEFAULT_SETTINGS.sendLimit),
      snapshotSeconds: clampInteger(snapshotSeconds, 1, 3600, DEFAULT_SETTINGS.snapshotSeconds),
      shortcut: DEFAULT_SETTINGS.shortcut,
      launcherEnabled: source.launcherEnabled !== false,
      customDomains: [...new Set((Array.isArray(source.customDomains) ? source.customDomains : [])
        .map(normalizeDomain).filter(Boolean))].slice(0, 100)
    };
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  function normalizeEntry(entry) {
    return entry?.kind === "enter" ? { ...entry, kind: "send" } : entry;
  }

  function normalizeDomain(value) {
    const raw = String(value || "").trim().toLocaleLowerCase();
    if (!raw) return "";
    try {
      const hostname = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
      return /^[a-z0-9.-]+$/.test(hostname) && hostname.includes(".") ? hostname : "";
    } catch {
      return "";
    }
  }

  function pruneEntries(entries, settings) {
    const limits = sanitizeSettings(settings);
    let sendCount = 0;
    return entries.filter(Boolean).map(normalizeEntry)
      .sort((left, right) => right.createdAt - left.createdAt)
      .filter((entry) => {
        if (entry.kind !== "send") return true;
        sendCount += 1;
        return sendCount <= limits.sendLimit;
      })
      .slice(0, limits.historyLimit);
  }

  function filterEntries(entries, query, sendOnly, site = "*") {
    const keyword = String(query || "").trim().toLocaleLowerCase();
    return entries.filter(Boolean).map(normalizeEntry)
      .sort((left, right) => right.createdAt - left.createdAt)
      .filter((entry) => site === "*" || entry.site === site)
      .filter((entry) => !sendOnly || entry.kind === "send")
      .filter((entry) => !keyword || entry.text.toLocaleLowerCase().includes(keyword));
  }

  /** Returns the newest automatic snapshot timestamp, optionally scoped to one site. */
  function latestSnapshotTime(entries, site = "*") {
    return entries.filter((entry) => entry?.kind === "snapshot" && (site === "*" || entry.site === site))
      .reduce((latest, entry) => Math.max(latest, Number(entry.createdAt) || 0), 0);
  }

  function initialState() {
    return { entries: [], drafts: {}, positions: {}, siteIcons: {} };
  }

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(error);
        else resolve(result);
      });
    });
  }

  function storageSet(value) {
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(value, () => {
        const error = chrome.runtime.lastError;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) reject(error);
        else resolve(response);
      });
    });
  }

  async function withStorageLock(task) {
    if (typeof chrome.runtime?.sendMessage !== "function") return task();
    const lock = await runtimeMessage({ type: "AIH_STORAGE_LOCK_ACQUIRE" });
    if (!lock?.token) throw new Error("无法获取本地存储写入锁");
    try {
      return await task();
    } finally {
      await runtimeMessage({ type: "AIH_STORAGE_LOCK_RELEASE", token: lock.token });
    }
  }

  function makeId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class HistoryStore {
    async getSettings() {
      const result = await storageGet(SETTINGS_KEY);
      return sanitizeSettings(result[SETTINGS_KEY]);
    }

    async saveSettings(nextSettings) {
      const settings = sanitizeSettings(nextSettings);
      await withStorageLock(async () => {
        await storageSet({ [SETTINGS_KEY]: settings });
        const state = await this.getState();
        state.entries = pruneEntries(state.entries, settings);
        await storageSet({ [STORAGE_KEY]: state });
      });
      return settings;
    }

    async getState() {
      const result = await storageGet(STORAGE_KEY);
      const stored = result[STORAGE_KEY];
      if (!stored || !Array.isArray(stored.entries)) return initialState();
      return {
        entries: stored.entries.map(normalizeEntry),
        drafts: stored.drafts && typeof stored.drafts === "object" ? stored.drafts : {},
        positions: stored.positions && typeof stored.positions === "object" ? stored.positions : {},
        siteIcons: stored.siteIcons && typeof stored.siteIcons === "object" ? stored.siteIcons : {}
      };
    }

    async addEntry(text, kind, context) {
      if (!String(text || "").trim()) return null;
      const normalizedKind = kind === "enter" ? "send" : kind;
      return withStorageLock(async () => {
        const [state, settings] = await Promise.all([this.getState(), this.getSettings()]);
        const latest = state.entries
          .filter((entry) => entry.kind === normalizedKind && entry.fieldKey === context.fieldKey)
          .sort((left, right) => right.createdAt - left.createdAt)[0];
        if (normalizedKind === "snapshot" && latest?.text === text) return latest;

        const entry = { id: makeId(), text, kind: normalizedKind, createdAt: Date.now(), site: context.site, title: context.title, fieldKey: context.fieldKey };
        state.entries = pruneEntries([entry, ...state.entries], settings);
        await storageSet({ [STORAGE_KEY]: state });
        return entry;
      });
    }

    async saveDraft(fieldKey, text, context) {
      await withStorageLock(async () => {
        const state = await this.getState();
        const drafts = { ...state.drafts };
        if (String(text || "").trim()) drafts[fieldKey] = { text, updatedAt: Date.now(), site: context.site, title: context.title };
        else delete drafts[fieldKey];
        state.drafts = Object.fromEntries(Object.entries(drafts)
          .sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, 50));
        await storageSet({ [STORAGE_KEY]: state });
      });
    }

    async getHistory(query, sendOnly, site = "*") {
      const state = await this.getState();
      const drafts = Object.entries(state.drafts).map(([fieldKey, draft]) => ({
        id: `draft:${fieldKey}`, text: draft.text, kind: "draft", createdAt: draft.updatedAt,
        site: draft.site, title: draft.title, fieldKey
      }));
      return filterEntries([...state.entries, ...drafts], query, sendOnly, site);
    }

    async getSites() {
      const state = await this.getState();
      const sites = new Set([
        ...state.entries.map((entry) => entry.site),
        ...Object.values(state.drafts).map((draft) => draft.site)
      ].filter(Boolean));
      return [...sites].sort((left, right) => left.localeCompare(right));
    }

    async getUiPosition(site) {
      const state = await this.getState();
      return state.positions[site] || {};
    }

    async saveUiPosition(site, type, position) {
      if (!["launcher", "panel"].includes(type) || !Number.isFinite(position?.x) || !Number.isFinite(position?.y)) return;
      await withStorageLock(async () => {
        const state = await this.getState();
        state.positions[site] = {
          ...(state.positions[site] || {}),
          [type]: { x: Math.round(position.x), y: Math.round(position.y) },
          updatedAt: Date.now()
        };
        state.positions = Object.fromEntries(Object.entries(state.positions)
          .sort(([, left], [, right]) => (right.updatedAt || 0) - (left.updatedAt || 0)).slice(0, 50));
        await storageSet({ [STORAGE_KEY]: state });
      });
    }

    async getSiteIcons() {
      const state = await this.getState();
      return state.siteIcons;
    }

    async saveSiteIcon(site, dataUrl) {
      if (!site || !/^data:image\//.test(dataUrl || "") || dataUrl.length > 180_000) return;
      await withStorageLock(async () => {
        const state = await this.getState();
        state.siteIcons[site] = { dataUrl, updatedAt: Date.now() };
        state.siteIcons = Object.fromEntries(Object.entries(state.siteIcons)
          .sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, 100));
        await storageSet({ [STORAGE_KEY]: state });
      });
    }

    async clearHistory() {
      await withStorageLock(async () => {
        const state = await this.getState();
        await storageSet({ [STORAGE_KEY]: { ...state, entries: [], drafts: {} } });
      });
    }
  }

  namespace.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  namespace.HistoryStore = HistoryStore;
  namespace.STORAGE_KEYS = { settings: SETTINGS_KEY, state: STORAGE_KEY };
  namespace.historyModel = { filterEntries, latestSnapshotTime, normalizeDomain, pruneEntries, sanitizeSettings };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
