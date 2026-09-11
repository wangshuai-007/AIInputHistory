(function initializeHistoryStore(namespace) {
  "use strict";

  const STORAGE_KEY = "aiInputHistoryState";
  const SETTINGS_KEY = "aiInputHistorySettings";
  const DEFAULT_SHORTCUT = "Ctrl+R";
  const DEFAULT_COMPLETION_NOTIFICATION = Object.freeze({
    enabled: false, provider: "browser", minDurationSeconds: 20, barkUrl: "", serverChanKey: "", pushPlusToken: "",
    ntfyUrl: "https://ntfy.sh", ntfyTopic: "", gotifyUrl: "", gotifyToken: "",
    dingtalkWebhook: "", feishuWebhook: "", wecomWebhook: "",
    customMethod: "POST", customUrl: "", customHeaders: "{}",
    customBody: '{"title":"{{title}}","message":"{{message}}"}'
  });
  const DEFAULT_SETTINGS = Object.freeze({
    historyLimit: 100,
    sendLimit: 10,
    snapshotSeconds: 60,
    shortcut: DEFAULT_SHORTCUT,
    language: "zh-CN",
    launcherEnabled: true,
    trackRequestTime: false,
    completionNotification: DEFAULT_COMPLETION_NOTIFICATION,
    customDomains: []
  });

  function sanitizeSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const snapshotSeconds = source.snapshotSeconds ?? (Number.parseInt(source.snapshotMinutes, 10) * 60 || DEFAULT_SETTINGS.snapshotSeconds);
    return {
      historyLimit: clampInteger(source.historyLimit, 20, 500, DEFAULT_SETTINGS.historyLimit),
      sendLimit: clampInteger(source.sendLimit ?? source.enterLimit, 1, 50, DEFAULT_SETTINGS.sendLimit),
      snapshotSeconds: clampInteger(snapshotSeconds, 1, 3600, DEFAULT_SETTINGS.snapshotSeconds),
      shortcut: normalizeShortcut(source.shortcut),
      language: source.language === "en" ? "en" : "zh-CN",
      launcherEnabled: source.launcherEnabled !== false,
      trackRequestTime: source.trackRequestTime === true,
      completionNotification: sanitizeCompletionNotification(source.completionNotification),
      customDomains: [...new Set((Array.isArray(source.customDomains) ? source.customDomains : [])
        .map(normalizeDomain).filter(Boolean))].slice(0, 100)
    };
  }

  function sanitizeCompletionNotification(value) {
    const source = value && typeof value === "object" ? value : {};
    const providers = new Set(["browser", "bark", "serverchan", "pushplus", "ntfy", "gotify", "dingtalk", "feishu", "wecom", "custom"]);
    const methods = new Set(["GET", "POST", "PUT", "PATCH"]);
    const text = (key, max, fallback = "") => String(source[key] ?? fallback).trim().slice(0, max);
    const method = String(source.customMethod || DEFAULT_COMPLETION_NOTIFICATION.customMethod).toUpperCase();
    return {
      enabled: source.enabled === true,
      provider: providers.has(source.provider) ? source.provider : DEFAULT_COMPLETION_NOTIFICATION.provider,
      minDurationSeconds: clampInteger(source.minDurationSeconds, 0, 3600, DEFAULT_COMPLETION_NOTIFICATION.minDurationSeconds),
      barkUrl: text("barkUrl", 1000), serverChanKey: text("serverChanKey", 300), pushPlusToken: text("pushPlusToken", 300),
      ntfyUrl: text("ntfyUrl", 1000, DEFAULT_COMPLETION_NOTIFICATION.ntfyUrl), ntfyTopic: text("ntfyTopic", 300),
      gotifyUrl: text("gotifyUrl", 1000), gotifyToken: text("gotifyToken", 300),
      dingtalkWebhook: text("dingtalkWebhook", 2000), feishuWebhook: text("feishuWebhook", 2000), wecomWebhook: text("wecomWebhook", 2000),
      customMethod: methods.has(method) ? method : DEFAULT_COMPLETION_NOTIFICATION.customMethod,
      customUrl: text("customUrl", 2000), customHeaders: text("customHeaders", 8000, "{}"),
      customBody: String(source.customBody ?? DEFAULT_COMPLETION_NOTIFICATION.customBody).slice(0, 16000)
    };
  }

  function clampInteger(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  }

  /** Normalizes a stored keyboard shortcut and preserves an explicitly disabled shortcut. */
  function normalizeShortcut(value) {
    if (value === "") return "";
    if (typeof value !== "string") return DEFAULT_SHORTCUT;
    const tokens = value.split("+").map((token) => token.trim()).filter(Boolean);
    const key = tokens.find((token) => !["Ctrl", "Alt", "Shift", "Meta"].includes(token));
    const modifiers = ["Ctrl", "Alt", "Shift", "Meta"].filter((modifier) => tokens.includes(modifier));
    if (!key || (modifiers.length === 0 && !/^F(?:[1-9]|1[0-2])$/.test(key))) return DEFAULT_SHORTCUT;
    return [...modifiers, key].join("+");
  }

  /** Converts a keyboard event to the canonical shortcut string used by settings. */
  function shortcutFromEvent(event) {
    const key = shortcutKey(event);
    if (!key) return "";
    const modifiers = [
      event.ctrlKey && "Ctrl",
      event.altKey && "Alt",
      event.shiftKey && "Shift",
      event.metaKey && "Meta"
    ].filter(Boolean);
    if (!modifiers.length && !/^F(?:[1-9]|1[0-2])$/.test(key)) return "";
    return [...modifiers, key].join("+");
  }

  /** Reports whether an event matches the currently configured shortcut. */
  function matchesShortcut(event, shortcut) {
    return Boolean(shortcut && !event.repeat && shortcutFromEvent(event) === normalizeShortcut(shortcut));
  }

  function shortcutKey(event) {
    if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return "";
    if (/^Key[A-Z]$/.test(event.code || "")) return event.code.slice(3);
    if (/^Digit[0-9]$/.test(event.code || "")) return event.code.slice(5);
    if (/^F(?:[1-9]|1[0-2])$/.test(event.key || "")) return event.key;
    const names = { " ": "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", "+": "Plus", "-": "Minus" };
    if (names[event.key]) return names[event.key];
    if (typeof event.key === "string" && event.key.length === 1) return event.key.toLocaleUpperCase();
    return ["Enter", "Tab", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown", "Insert"].includes(event.key) ? event.key : "";
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
    let historyCount = 0;
    return entries.filter(Boolean).map(normalizeEntry)
      .sort((left, right) => right.createdAt - left.createdAt)
      .filter((entry) => {
        if (entry.pinned) return true;
        if (entry.kind === "send" && ++sendCount > limits.sendLimit) return false;
        return ++historyCount <= limits.historyLimit;
      });
  }

  /** Removes incremental snapshots from the current composition after its previous send. */
  function collapseSnapshotsForSend(entries, fieldKey, sessionId = "") {
    const previousSendAt = entries
      .filter((entry) => entry?.kind === "send" && entry.fieldKey === fieldKey)
      .reduce((latest, entry) => Math.max(latest, Number(entry.createdAt) || 0), 0);
    return entries.filter((entry) => {
      if (entry?.pinned || entry?.kind !== "snapshot") return true;
      if (sessionId && entry.sessionId) return entry.sessionId !== sessionId;
      return entry.fieldKey !== fieldKey || (Number(entry.createdAt) || 0) <= previousSendAt;
    });
  }

  /** Hides legacy snapshots that were superseded by a later send from the same composition. */
  function compactSentSnapshots(entries) {
    const sends = entries.filter((entry) => entry?.kind === "send");
    const sentSessions = new Set(sends.map((entry) => entry.sessionId).filter(Boolean));
    const sentFields = new Map();
    for (const entry of sends) {
      sentFields.set(entry.fieldKey, Math.max(sentFields.get(entry.fieldKey) || 0, Number(entry.createdAt) || 0));
    }
    return entries.filter((entry) => {
      if (entry?.pinned || entry?.kind !== "snapshot") return true;
      if (entry.sessionId) return !sentSessions.has(entry.sessionId);
      return !sentFields.has(entry.fieldKey) || sentFields.get(entry.fieldKey) < (Number(entry.createdAt) || 0);
    });
  }

  function filterEntries(entries, query, sendOnly, site = "*", pinnedOnly = false) {
    const keyword = String(query || "").trim().toLocaleLowerCase();
    return entries.filter(Boolean).map(normalizeEntry)
      .sort((left, right) => right.createdAt - left.createdAt)
      .filter((entry) => site === "*" || entry.site === site)
      .filter((entry) => !sendOnly || entry.kind === "send")
      .filter((entry) => !pinnedOnly || entry.pinned)
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
      return this.patchSettings(sanitizeSettings(nextSettings));
    }

    /** Merges only changed settings under the shared write lock to preserve other windows' changes. */
    async patchSettings(patch) {
      let settings;
      await withStorageLock(async () => {
        settings = sanitizeSettings({ ...await this.getSettings(), ...patch });
        const state = await this.getState();
        state.entries = pruneEntries(state.entries, settings);
        await storageSet({ [SETTINGS_KEY]: settings, [STORAGE_KEY]: state });
      });
      return settings;
    }

    async getState() {
      const result = await storageGet(STORAGE_KEY);
      const stored = result[STORAGE_KEY];
      if (!stored || !Array.isArray(stored.entries)) return initialState();
      return {
        entries: compactSentSnapshots(stored.entries.filter((entry) => entry && typeof entry.text === "string").map(normalizeEntry)),
        drafts: Object.fromEntries(Object.entries(stored.drafts || {}).filter(([, draft]) => draft && typeof draft.text === "string")),
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
          .filter((entry) => entry.kind === normalizedKind && entry.fieldKey === context.fieldKey
            && (entry.sessionId || "") === (context.sessionId || ""))
          .sort((left, right) => right.createdAt - left.createdAt)[0];
        if (normalizedKind === "snapshot" && latest?.text === text) return latest;

        const entry = { id: makeId(), text, kind: normalizedKind, createdAt: Date.now(), site: context.site, title: context.title, fieldKey: context.fieldKey, sessionId: context.sessionId || "" };
        if (normalizedKind === "send" && Number.isFinite(context.sentAt)) entry.createdAt = context.sentAt;
        if (normalizedKind === "send" && context.trackRequestTime) {
          entry.requestTiming = { status: "pending", startedAt: entry.createdAt };
        }
        const existingEntries = normalizedKind === "send"
          ? collapseSnapshotsForSend(state.entries, context.fieldKey, context.sessionId)
          : state.entries;
        state.entries = pruneEntries([entry, ...existingEntries], settings);
        await storageSet({ [STORAGE_KEY]: state });
        return entry;
      });
    }

    async saveDraft(fieldKey, text, context) {
      await withStorageLock(async () => {
        const state = await this.getState();
        const drafts = { ...state.drafts };
        const key = context.sessionId ? `${fieldKey}:session:${context.sessionId}` : fieldKey;
        if (String(text || "").trim()) {
          drafts[key] = { text, updatedAt: Date.now(), site: context.site, title: context.title, fieldKey, sessionId: context.sessionId || "" };
        } else delete drafts[key];
        state.drafts = Object.fromEntries(Object.entries(drafts)
          .sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, 50));
        await storageSet({ [STORAGE_KEY]: state });
      });
    }

    async getHistory(query, sendOnly, site = "*", pinnedOnly = false) {
      const state = await this.getState();
      const drafts = Object.entries(state.drafts).map(([key, draft]) => ({
        id: `draft:${key}`, text: draft.text, kind: "draft", createdAt: draft.updatedAt,
        site: draft.site, title: draft.title, fieldKey: draft.fieldKey || key, sessionId: draft.sessionId || ""
      }));
      return filterEntries([...state.entries, ...drafts], query, sendOnly, site, pinnedOnly);
    }

    /** Pins a stored entry or preserves the displayed draft as an immutable snapshot. */
    async setPinned(displayedEntry, pinned) {
      return withStorageLock(async () => {
        const state = await this.getState();
        let entry = state.entries.find((item) => item.id === displayedEntry.id);
        if (!entry && pinned && displayedEntry.kind === "draft") {
          entry = state.entries.find((item) => item.sourceDraftId === displayedEntry.id
            && item.createdAt === displayedEntry.createdAt && item.text === displayedEntry.text);
          if (!entry) {
            entry = { ...displayedEntry, id: makeId(), kind: "snapshot", sourceDraftId: displayedEntry.id };
            state.entries.push(entry);
          }
        }
        if (!entry) throw new Error("记录已不存在 / Entry no longer exists");
        entry.pinned = Boolean(pinned);
        state.entries = pruneEntries(state.entries, await this.getSettings());
        await storageSet({ [STORAGE_KEY]: state });
        return entry;
      });
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

    /** Updates timing metadata on an existing send only, without reviving cleared or evicted history. */
    async updateRequestTiming(id, timing) {
      if (!["completed", "cancelled", "failed", "timeout"].includes(timing?.status)) throw new Error("无效计时状态");
      if (!Number.isFinite(timing.startedAt)) throw new Error("无效发送时间");
      const value = { status: timing.status, startedAt: timing.startedAt };
      if (timing.status === "completed") {
        if (!Number.isFinite(timing.completedAt) || timing.completedAt < timing.startedAt) throw new Error("无效回复时间");
        value.completedAt = timing.completedAt;
        value.durationMs = timing.completedAt - timing.startedAt;
      }
      return withStorageLock(async () => {
        const state = await this.getState();
        const entry = state.entries.find((item) => item.id === id && item.kind === "send");
        if (!entry) return false;
        entry.requestTiming = value;
        await storageSet({ [STORAGE_KEY]: state });
        return true;
      });
    }

    async clearHistory() {
      await withStorageLock(async () => {
        const state = await this.getState();
        await storageSet({ [STORAGE_KEY]: { ...state, entries: state.entries.filter((entry) => entry.pinned), drafts: {} } });
      });
    }
  }

  namespace.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  namespace.DEFAULT_COMPLETION_NOTIFICATION = DEFAULT_COMPLETION_NOTIFICATION;
  namespace.HistoryStore = HistoryStore;
  namespace.STORAGE_KEYS = { settings: SETTINGS_KEY, state: STORAGE_KEY };
  namespace.historyModel = { collapseSnapshotsForSend, compactSentSnapshots, filterEntries, latestSnapshotTime, matchesShortcut, normalizeDomain, normalizeShortcut, pruneEntries, sanitizeCompletionNotification, sanitizeSettings, shortcutFromEvent };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
