const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function model() {
  const context = { globalThis: {}, URL, URLSearchParams, Date };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "completion-notification.js"), "utf8"), context);
  return context.AIInputHistory.notificationModel;
}

test("默认通知正文截取问题前 32 个字符并省略超出部分", () => {
  const m = model();
  const text = "请帮我分析这个项目里为什么上传图片后发送按钮状态发生变化以及如何可靠检测完成";
  const payload = m.makePayload({ promptText: text }, "zh-CN");
  assert.ok(Array.from(payload.message.replace(/…$/, "")).length <= 32);
  assert.equal(payload.message.endsWith("…"), true);
  assert.equal(payload.question, text);
});

test("纯图片或附件请求使用明确的默认提示", () => {
  const m = model();
  assert.equal(m.makePayload({ promptText: "" }, "zh-CN").message, "图片或附件请求");
  assert.equal(m.makePayload({ promptText: "" }, "en").message, "Image or attachment request");
});

test("常见推送渠道生成预期的请求", () => {
  const m = model();
  const payload = m.makePayload({ promptText: "解释这个错误" }, "zh-CN");
  const bark = m.buildRequest({ provider: "bark", barkUrl: "https://api.day.app/key" }, payload);
  assert.equal(bark.url, "https://api.day.app/key");
  assert.equal(JSON.parse(bark.body).body, "解释这个错误");

  const serverchan = m.buildRequest({ provider: "serverchan", serverChanKey: "SCT123" }, payload);
  assert.equal(serverchan.url, "https://sctapi.ftqq.com/SCT123.send");
  assert.match(serverchan.body, /title=/);

  const pushplus = m.buildRequest({ provider: "pushplus", pushPlusToken: "token" }, payload);
  assert.equal(JSON.parse(pushplus.body).token, "token");

  const ntfy = m.buildRequest({ provider: "ntfy", ntfyUrl: "https://ntfy.sh", ntfyTopic: "gpt" }, payload);
  assert.equal(ntfy.url, "https://ntfy.sh/gpt");
  assert.equal(ntfy.body, "解释这个错误");

  const gotify = m.buildRequest({ provider: "gotify", gotifyUrl: "https://gotify.example.com", gotifyToken: "abc" }, payload);
  assert.match(gotify.url, /\/message\?token=abc$/);

  const dingtalk = m.buildRequest({ provider: "dingtalk", dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=abc" }, payload);
  assert.equal(JSON.parse(dingtalk.body).msgtype, "text");
  assert.match(JSON.parse(dingtalk.body).text.content, /ChatGPT 回复完成/);
  const feishu = m.buildRequest({ provider: "feishu", feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/abc" }, payload);
  assert.equal(JSON.parse(feishu.body).msg_type, "text");
  assert.equal(JSON.parse(feishu.body).content.text.includes("解释这个错误"), true);
  const wecom = m.buildRequest({ provider: "wecom", wecomWebhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc" }, payload);
  assert.equal(JSON.parse(wecom.body).msgtype, "text");
  assert.equal(m.requiredOrigin({ provider: "wecom", wecomWebhook: wecom.url }), "https://qyapi.weixin.qq.com/*");
  assert.throws(() => m.buildRequest({ provider: "dingtalk", dingtalkWebhook: "http://oapi.dingtalk.com/robot/send?access_token=abc" }, payload), /HTTPS/);
});

test("自定义请求替换 URL、Headers 和 Body 模板变量", () => {
  const m = model();
  const payload = {
    title: "ChatGPT 回复完成", message: "检查数据库连接…", question: "检查数据库连接为什么失败",
    duration: "12.3s", completedAt: "2026/9/10 17:00:00", pageUrl: "https://chatgpt.com/c/abc"
  };
  const request = m.buildRequest({
    provider: "custom", customMethod: "PATCH",
    customUrl: "https://notify.example.com/push?title={{title}}",
    customHeaders: '{"Authorization":"Bearer abc","X-Duration":"{{duration}}"}',
    customBody: '{"text":"{{message}}","full":"{{question}}","url":"{{pageUrl}}"}'
  }, payload);
  assert.equal(request.method, "PATCH");
  assert.match(request.url, /title=ChatGPT/);
  assert.equal(request.headers["X-Duration"], "12.3s");
  assert.match(request.body, /检查数据库连接/);
  assert.equal(m.requiredOrigin({ provider: "custom", customUrl: "https://notify.example.com/push" }), "https://notify.example.com/*");
});

test("机器人 HTTP 200 但业务错误时仍报告失败", () => {
  const m = model();
  assert.doesNotThrow(() => m.validateResponse("dingtalk", '{"errcode":0,"errmsg":"ok"}'));
  assert.doesNotThrow(() => m.validateResponse("feishu", '{"StatusCode":0,"StatusMessage":"success"}'));
  assert.doesNotThrow(() => m.validateResponse("wecom", '{"errcode":0,"errmsg":"ok"}'));
  assert.throws(() => m.validateResponse("dingtalk", '{"errcode":310000,"errmsg":"keywords not in content"}'), /keywords/);
  assert.throws(() => m.validateResponse("feishu", '{"code":19024,"msg":"Key Words Not Found"}'), /Key Words/);
  assert.throws(() => m.validateResponse("wecom", '{"errcode":93000,"errmsg":"invalid webhook url"}'), /invalid webhook/);
});

test("自定义请求拒绝非 HTTP 地址和无效 Headers JSON", () => {
  const m = model();
  const payload = m.makePayload({ promptText: "test" }, "zh-CN");
  assert.throws(() => m.buildRequest({ provider: "custom", customUrl: "file:///tmp/x" }, payload));
  assert.throws(() => m.buildRequest({ provider: "custom", customUrl: "https://example.com", customHeaders: "[]" }, payload));
});
