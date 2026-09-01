const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function load(relativePath, context) {
  const source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
  vm.runInNewContext(source, context);
}

const context = { globalThis: {} };
load(path.join("src", "site-profiles.js"), context);
load(path.join("src", "site-filter.js"), context);
const profiles = context.globalThis.AIInputHistory.SiteProfiles;
const { orderSites } = context.globalThis.AIInputHistory.siteFilterModel;

test("识别 Gemini、Grok、GLM 和 Qwen 官方站点", () => {
  assert.equal(profiles.forSite("gemini.google.com").id, "gemini");
  assert.equal(profiles.forSite("grok.com").id, "grok");
  assert.equal(profiles.forSite("chat.z.ai").id, "glm");
  assert.equal(profiles.forSite("chatglm.cn").id, "glm");
  assert.equal(profiles.forSite("chat.qwen.ai").id, "qwen");
  assert.equal(profiles.forSite("claude.ai").id, "claude");
  assert.equal(profiles.forSite("aistudio.google.com").id, "aistudio");
  assert.equal(profiles.forSite("chat.deepseek.com").id, "deepseek");
  assert.equal(profiles.forSite("chatgpt.com").id, "chatgpt");
});

test("AI 站点图标使用对应的本地品牌资源", () => {
  assert.match(profiles.icon("grok.com"), /ai-logo grok/);
  assert.match(profiles.icon("chat.z.ai"), /ai-logo glm/);
  assert.match(profiles.icon("chat.qwen.ai"), /ai-logo qwen/);
  assert.match(profiles.icon("claude.ai"), /ai-logo claude/);
  assert.match(profiles.icon("aistudio.google.com"), /ai-logo aistudio/);
  assert.match(profiles.icon("chat.deepseek.com"), /ai-logo deepseek/);
  assert.match(profiles.icon("chatgpt.com"), /ai-logo chatgpt/);
});

test("每个已适配站点都包含本地官方图标资源", () => {
  for (const profile of profiles.PROFILES) {
    const relativePath = profiles.logoUrl(profile.id).replace(/^\.\.\//, "");
    assert.equal(fs.existsSync(path.join(__dirname, "..", relativePath)), true, `缺少 ${profile.name} 图标`);
  }
});

test("筛选菜单始终把全部网站放在第一项", () => {
  const result = orderSites("grok.com", ["chat.qwen.ai", "grok.com", "chat.z.ai"]);
  assert.deepEqual(Array.from(result), ["*", "grok.com", "chat.qwen.ai", "chat.z.ai"]);
});

test("Copilot、Perplexity、Kimi、豆包使用专项输入框选择器", () => {
  const element = (matchedSelector) => ({ matches: (selector) => selector === matchedSelector });
  assert.equal(profiles.matchesComposer(element("textarea#userInput"), "copilot.microsoft.com"), true);
  assert.equal(profiles.matchesComposer(element("textarea[placeholder*='Ask']"), "www.perplexity.ai"), true);
  assert.equal(profiles.matchesComposer(element("[data-slate-editor='true']"), "www.kimi.com"), true);
  assert.equal(profiles.matchesComposer(element("[contenteditable='true'][data-testid*='chat']"), "www.doubao.com"), true);
});

test("四个站点使用专项发送按钮选择器", () => {
  const button = (matchedSelector) => ({ matches: (selector) => selector === matchedSelector });
  assert.equal(profiles.matchesSendButton(button("button[data-testid*='submit']"), "copilot.microsoft.com"), true);
  assert.equal(profiles.matchesSendButton(button("button[aria-label='Submit']"), "perplexity.ai"), true);
  assert.equal(profiles.matchesSendButton(button("button[class*='send-button']"), "kimi.com"), true);
  assert.equal(profiles.matchesSendButton(button("button[class*='send-btn']"), "doubao.com"), true);
});

test("默认只允许内置 AI 网站，自定义域名可额外启用", () => {
  assert.equal(profiles.isAllowedSite("claude.ai", []), true);
  assert.equal(profiles.isAllowedSite("news.example.com", []), false);
  assert.equal(profiles.isAllowedSite("chat.example.com", ["example.com"]), true);
});

test("访问网站后优先使用页面缓存的官方图标", () => {
  const dataUrl = "data:image/png;base64,YWk=";
  profiles.setSiteIcons({ "custom.example": { dataUrl, updatedAt: 1 } });
  assert.match(profiles.icon("custom.example"), /data:image\/png;base64,YWk=/);
  profiles.setSiteIcons({});
});

test("内置 AI 的 Enter 发送会在页面响应前识别，Shift+Enter 仍是换行", () => {
  assert.equal(profiles.isSendShortcut({ key: "Enter", defaultPrevented: true, shiftKey: false, isComposing: false }, "chatgpt.com"), true);
  assert.equal(profiles.isSendShortcut({ key: "Enter", defaultPrevented: false, shiftKey: false, isComposing: false }, "chatgpt.com"), false);
  assert.equal(profiles.isSendShortcut({ key: "Enter", defaultPrevented: true, shiftKey: true, isComposing: false }, "chatgpt.com"), false);
  assert.equal(profiles.isSendShortcut({ key: "Enter", defaultPrevented: true, shiftKey: false, isComposing: false }, "custom.example"), false);
});
