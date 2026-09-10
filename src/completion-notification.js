(function initializeCompletionNotification(namespace) {
  "use strict";

  const PROVIDERS = new Set(["browser", "bark", "serverchan", "pushplus", "ntfy", "gotify", "dingtalk", "feishu", "wecom", "custom"]);
  const METHODS = new Set(["GET", "POST", "PUT", "PATCH"]);

  function compactText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function abbreviate(value, limit = 32) {
    const chars = Array.from(compactText(value));
    return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit).join("")}…`;
  }

  function makePayload(event = {}, language = "zh-CN") {
    const english = language === "en";
    const question = compactText(event.promptText);
    const fallback = english ? "Image or attachment request" : "图片或附件请求";
    const duration = Number.isFinite(event.durationMs) ? `${(event.durationMs / 1000).toFixed(1)}s` : "";
    return {
      title: english ? "ChatGPT reply completed" : "ChatGPT 回复完成",
      message: abbreviate(question || fallback), question, duration,
      completedAt: Number.isFinite(event.completedAt) ? new Date(event.completedAt).toLocaleString(english ? "en-US" : "zh-CN") : "",
      pageUrl: String(event.pageUrl || "")
    };
  }

  function renderTemplate(template, values) {
    return String(template || "").replace(/\{\{(title|message|question|duration|completedAt|pageUrl)\}\}/g, (_, key) => values[key] ?? "");
  }

  function ensureHttpUrl(value, label) {
    let url;
    try { url = new URL(String(value || "").trim()); }
    catch { throw new Error(`${label} 地址无效`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`${label} 仅支持 HTTP/HTTPS`);
    return url;
  }

  function ensureWebhookUrl(value, label) {
    const url = ensureHttpUrl(value, label);
    if (url.protocol !== "https:") throw new Error(`${label} 必须使用 HTTPS`);
    return url;
  }

  function endpointFor(config = {}) {
    const provider = PROVIDERS.has(config.provider) ? config.provider : "browser";
    if (provider === "browser") return null;
    if (provider === "bark") return ensureHttpUrl(config.barkUrl, "Bark").toString();
    if (provider === "serverchan") {
      if (!config.serverChanKey) throw new Error("请填写 Server酱 SendKey");
      return `https://sctapi.ftqq.com/${encodeURIComponent(config.serverChanKey)}.send`;
    }
    if (provider === "pushplus") return "https://www.pushplus.plus/send";
    if (provider === "ntfy") {
      if (!config.ntfyTopic) throw new Error("请填写 ntfy Topic");
      const base = ensureHttpUrl(config.ntfyUrl || "https://ntfy.sh", "ntfy").toString().replace(/\/$/, "");
      return `${base}/${encodeURIComponent(config.ntfyTopic)}`;
    }
    if (provider === "gotify") {
      if (!config.gotifyToken) throw new Error("请填写 Gotify Token");
      const base = ensureHttpUrl(config.gotifyUrl, "Gotify").toString().replace(/\/$/, "");
      return `${base}/message?token=${encodeURIComponent(config.gotifyToken)}`;
    }
    if (provider === "dingtalk") return ensureWebhookUrl(config.dingtalkWebhook, "钉钉机器人 Webhook").toString();
    if (provider === "feishu") return ensureWebhookUrl(config.feishuWebhook, "飞书机器人 Webhook").toString();
    if (provider === "wecom") return ensureWebhookUrl(config.wecomWebhook, "企业微信机器人 Webhook").toString();
    return renderTemplate(config.customUrl, { title: "x", message: "x", question: "x", duration: "1s", completedAt: "x", pageUrl: "https://chatgpt.com/" });
  }

  function requiredOrigin(config = {}) {
    const endpoint = endpointFor(config);
    if (!endpoint) return null;
    const url = ensureHttpUrl(endpoint, "通知");
    return `${url.protocol}//${url.hostname}/*`;
  }

  function jsonBody(value) {
    return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
  }

  function buildRequest(config = {}, payload) {
    const provider = PROVIDERS.has(config.provider) ? config.provider : "browser";
    if (provider === "browser") return { kind: "browser", title: payload.title, message: payload.message };
    const url = endpointFor(config);
    if (provider === "bark") return { kind: "http", url, method: "POST", ...jsonBody({ title: payload.title, body: payload.message, group: "AI Input History" }) };
    if (provider === "serverchan") return {
      kind: "http", url, method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ title: payload.title, desp: payload.message }).toString()
    };
    if (provider === "pushplus") {
      if (!config.pushPlusToken) throw new Error("请填写 PushPlus Token");
      return { kind: "http", url, method: "POST", ...jsonBody({ token: config.pushPlusToken, title: payload.title, content: payload.message }) };
    }
    if (provider === "ntfy") return { kind: "http", url, method: "POST", headers: { Title: payload.title }, body: payload.message };
    if (provider === "gotify") return { kind: "http", url, method: "POST", ...jsonBody({ title: payload.title, message: payload.message, priority: 5 }) };
    const robotText = `${payload.title}\n${payload.message}`;
    if (provider === "dingtalk") return { kind: "http", url, method: "POST", ...jsonBody({ msgtype: "text", text: { content: robotText } }) };
    if (provider === "feishu") return { kind: "http", url, method: "POST", ...jsonBody({ msg_type: "text", content: { text: robotText } }) };
    if (provider === "wecom") return { kind: "http", url, method: "POST", ...jsonBody({ msgtype: "text", text: { content: robotText } }) };
    const method = METHODS.has(String(config.customMethod || "POST").toUpperCase()) ? String(config.customMethod || "POST").toUpperCase() : "POST";
    const renderedUrl = renderTemplate(config.customUrl, payload);
    ensureHttpUrl(renderedUrl, "自定义通知");
    let headers = {};
    try {
      const parsed = JSON.parse(renderTemplate(config.customHeaders || "{}", payload));
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      headers = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
    } catch { throw new Error("自定义 Headers 必须是 JSON 对象"); }
    const request = { kind: "http", url: renderedUrl, method, headers };
    if (method !== "GET") request.body = renderTemplate(config.customBody, payload);
    return request;
  }

  function buildDelivery(config, event, language) {
    return buildRequest(config, makePayload(event, language));
  }

  function validateResponse(provider, text) {
    if (!["dingtalk", "feishu", "wecom"].includes(provider) || !String(text || "").trim()) return;
    let payload;
    try { payload = JSON.parse(text); }
    catch { return; }
    const code = provider === "feishu" ? (payload.code ?? payload.StatusCode) : payload.errcode;
    if (code == null || Number(code) === 0) return;
    const message = payload.errmsg || payload.msg || payload.StatusMessage || `code ${code}`;
    throw new Error(`通知服务返回失败：${message}`);
  }

  namespace.notificationModel = {
    abbreviate, buildDelivery, buildRequest, endpointFor, makePayload, renderTemplate, requiredOrigin, validateResponse
  };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
