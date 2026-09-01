(function initializeSiteProfiles(namespace) {
  "use strict";

  const STANDARD_COMPOSERS = ["textarea", ".ProseMirror[contenteditable='true']", "[contenteditable='true'][role='textbox']", "[contenteditable='true'][data-placeholder]"];
  const STANDARD_SEND = ["button[type='submit']", "button[class*='send']", "button[aria-label*='Send']", "button[aria-label*='发送']", "button[aria-label*='Submit']"];

  const PROFILES = [
    profile("gemini", "Gemini", ["gemini.google.com"], ["rich-textarea [contenteditable='true']", ".ql-editor[contenteditable='true']", "[data-placeholder][contenteditable='true']"], ["button.send-button", "button[aria-label*='Send']"]),
    profile("grok", "Grok", ["grok.com"]),
    profile("glm", "GLM", ["chat.z.ai", "z.ai", "chatglm.cn"]),
    profile("qwen", "Qwen", ["chat.qwen.ai", "qwen.ai", "qianwen.com", "tongyi.aliyun.com"]),
    profile("chatgpt", "ChatGPT", ["chatgpt.com", "chat.openai.com"]),
    profile("claude", "Claude", ["claude.ai"]),
    profile("aistudio", "Google AI Studio", ["aistudio.google.com"]),
    profile("deepseek", "DeepSeek", ["chat.deepseek.com"]),
    profile(
      "copilot",
      "Copilot",
      ["copilot.microsoft.com"],
      ["textarea#userInput", "textarea[placeholder*='Copilot']", "[contenteditable='true'][aria-label*='Copilot']"],
      ["button[data-testid*='submit']", "button[aria-label*='Submit message']"]
    ),
    profile(
      "perplexity",
      "Perplexity",
      ["perplexity.ai"],
      ["textarea[placeholder*='Ask']", "textarea[aria-label*='Ask']", "[contenteditable='true'][data-lexical-editor='true']"],
      ["button[data-testid*='submit']", "button[aria-label='Submit']"]
    ),
    profile(
      "kimi",
      "Kimi",
      ["kimi.com", "kimi.moonshot.cn"],
      ["[data-slate-editor='true']", ".chat-input-editor[contenteditable='true']", "textarea[placeholder*='Ask anything']"],
      ["button[data-testid*='send']", "button[class*='send-button']"]
    ),
    profile(
      "doubao",
      "豆包",
      ["doubao.com"],
      ["[data-slate-editor='true']", "[contenteditable='true'][data-testid*='chat']", "textarea[placeholder*='豆包']"],
      ["button[data-testid*='send']", "button[class*='send-btn']"]
    ),
    profile("yuanbao", "腾讯元宝", ["yuanbao.tencent.com"]),
    profile("ernie", "文小言", ["yiyan.baidu.com", "chat.baidu.com"]),
    profile("mistral", "Mistral", ["chat.mistral.ai"]),
    profile("poe", "Poe", ["poe.com"]),
    profile("meta", "Meta AI", ["meta.ai"]),
    profile("you", "You.com", ["you.com"])
  ];
  let cachedSiteIcons = {};

  function profile(id, name, domains, composerSelectors = [], sendSelectors = []) {
    return {
      id,
      name,
      domains,
      composerSelectors: [...STANDARD_COMPOSERS, ...composerSelectors],
      sendSelectors: [...STANDARD_SEND, ...sendSelectors]
    };
  }

  function forSite(site) {
    const hostname = String(site || "").toLocaleLowerCase().replace(/^www\./, "");
    return PROFILES.find((item) => item.domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) || null;
  }

  function displayName(site) {
    if (site === "*") return "全部网站";
    return forSite(site)?.name || site;
  }

  function isAllowedSite(site, customDomains = []) {
    const hostname = normalizeSite(site);
    if (forSite(hostname)) return true;
    return customDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  }

  function icon(site) {
    const id = site === "*" ? "all" : forSite(site)?.id || "web";
    const cached = cachedSiteIcons[site]?.dataUrl;
    if (cached) return `<img class="ai-logo ${id}" src="${cached}" alt="" draggable="false">`;
    if (id === "all") return `<svg class="ai-logo all" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="4" height="4" rx="1"/><rect x="9" y="3" width="4" height="4" rx="1"/><rect x="3" y="9" width="4" height="4" rx="1"/><rect x="9" y="9" width="4" height="4" rx="1"/></svg>`;
    if (id === "web") return `<svg class="ai-logo web" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2.4 8h11.2M8 2c1.8 1.7 2.7 3.7 2.7 6S9.8 12.3 8 14C6.2 12.3 5.3 10.3 5.3 8S6.2 3.7 8 2Z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>`;
    return `<img class="ai-logo ${id}" src="${logoUrl(id)}" alt="" draggable="false">`;
  }

  function setSiteIcons(icons) {
    cachedSiteIcons = icons && typeof icons === "object" ? icons : {};
  }

  function logoUrl(id) {
    const extension = id === "ernie" ? "svg" : "png";
    const path = `assets/logos/${id}.${extension}`;
    if (typeof globalThis.chrome?.runtime?.getURL === "function") return globalThis.chrome.runtime.getURL(path);
    return `../${path}`;
  }

  function matchesComposer(element, site) {
    const item = forSite(site);
    return Boolean(item && item.composerSelectors.some((selector) => element.matches(selector)));
  }

  function matchesSendButton(button, site) {
    const item = forSite(site);
    return Boolean(item && item.sendSelectors.some((selector) => button.matches(selector)));
  }

  function isSendShortcut(event, site) {
    return Boolean(forSite(site) && event?.key === "Enter" && event.defaultPrevented && !event.shiftKey && !event.isComposing);
  }

  function normalizeSite(site) {
    return String(site || "").toLocaleLowerCase().replace(/^www\./, "");
  }

  namespace.SiteProfiles = { PROFILES, displayName, forSite, icon, isAllowedSite, isSendShortcut, logoUrl, matchesComposer, matchesSendButton, setSiteIcons };
})(globalThis.AIInputHistory = globalThis.AIInputHistory || {});
