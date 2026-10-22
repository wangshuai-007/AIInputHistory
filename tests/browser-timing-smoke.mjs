import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chromePath = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
].find(fs.existsSync);
if (!chromePath) throw new Error("未找到 Chrome 或 Edge");
if (typeof WebSocket !== "function") throw new Error("当前 Node.js 不支持 WebSocket");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const server = http.createServer((request, response) => {
  const relative = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname).replace(/^\/+/, "");
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
  fs.readFile(file, (error, data) => {
    if (error) { response.writeHead(404).end(); return; }
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type }); response.end(data);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const webPort = server.address().port;
const debugPort = await freePort();
const profile = path.join(os.tmpdir(), `aih-browser-${process.pid}-${Date.now()}`);
const targetUrl = `http://127.0.0.1:${webPort}/store-assets/screenshot-fixture.html?lang=zh-CN&timing=1&notify=1&pro=1`;
const browser = spawn(chromePath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"
], { stdio: "ignore" });

async function pageTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      const page = targets.find((item) => item.type === "page");
      if (page) return page;
    } catch {}
    await sleep(100);
  }
  throw new Error("无法连接 Chrome DevTools Protocol");
}

const target = await pageTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
let sequence = 0;
const pending = new Map();
const browserEvents = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) {
    if (["Runtime.exceptionThrown", "Runtime.consoleAPICalled"].includes(message.method)) browserEvents.push(message);
    return;
  }
  if (!pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
});
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
  return result.result.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`等待页面状态超时: ${expression}`);
}

try {
  await Promise.all([send("Runtime.enable"), send("Page.enable")]);
  await send("Page.navigate", { url: targetUrl });
  await waitFor(`location.href.includes("screenshot-fixture.html") && Boolean(document.querySelector("[data-ai-input-history='root']")?.shadowRoot?.querySelector(".launcher"))`);
  await sleep(700);
  const groupedDomContract = await evaluate(`(()=>{const thread=document.querySelector(".thread");const group=document.createElement("section");group.setAttribute("data-turn-key","grouped-contract");group.innerHTML='<div data-user-message-bubble>用户问题</div><button data-testid="copy-turn-action-button" type="button">复制用户消息</button><div data-conversation-role="assistant">新版结构回复</div>';thread.appendChild(group);const before=AIInputHistory.requestTimingModel.sampleChatGPT();const footer=document.createElement("div");footer.className="turn-action-controls";footer.innerHTML='<button data-testid="copy-turn-action-button" type="button">复制回复</button>';group.appendChild(footer);const after=AIInputHistory.requestTimingModel.sampleChatGPT();const form=document.createElement("form");form.setAttribute("data-chatgpt-composer","");form.style.position="fixed";form.style.left="20px";form.style.top="20px";const stop=document.createElement("button");stop.type="button";stop.setAttribute("aria-label","Stop");stop.textContent="Stop";form.appendChild(stop);document.body.appendChild(form);const withStop=AIInputHistory.requestTimingModel.sampleChatGPT();form.remove();group.remove();return {before:before.replies.at(-1),after:after.replies.at(-1),busyWithNewStop:withStop.busy}})()`);
  assert.equal(groupedDomContract.before?.key, "assistant-group:grouped-contract", "新版 data-turn-key assistant 应被识别为回复");
  assert.equal(groupedDomContract.before?.nonempty, true, "新版 data-conversation-role=assistant 应识别出回复正文");
  assert.equal(groupedDomContract.before?.complete, false, "同组中位于 assistant 之前的用户 Copy 按钮不能误判为回复完成");
  assert.equal(groupedDomContract.after?.complete, true, "新版 copy-turn-action-button 应识别为回复完成");
  assert.equal(groupedDomContract.busyWithNewStop, true, "新版 composer 内 aria-label=Stop 按钮应识别为生成中");
  const staleMarkersContract = await evaluate(`(()=>{
    const thread = document.querySelector(".thread");
    const older = document.createElement("article");
    older.innerHTML = '<div data-message-author-role="assistant" data-is-streaming="true">旧回复</div><button data-testid="stop-button">停止</button>';
    const latest = document.createElement("article");
    latest.innerHTML = '<div data-message-author-role="assistant">已经完成的新回复</div><button aria-label="Copy response">复制</button>';
    thread.append(older, latest);
    const clean = AIInputHistory.requestTimingModel.sampleChatGPT();
    latest.querySelector('[data-message-author-role="assistant"]').setAttribute('data-is-streaming','true');
    const currentStreaming = AIInputHistory.requestTimingModel.sampleChatGPT();
    older.remove(); latest.remove();
    return { cleanBusy: clean.busy, cleanButton: clean.buttonState.processing,
      currentStreamingBusy: currentStreaming.busy, currentStreamingOnly: currentStreaming.streamingOnly };
  })()`);
  assert.equal(staleMarkersContract.cleanBusy, false, "旧回复残留 Stop 和 streaming 不能阻塞最新完成回复");
  assert.equal(staleMarkersContract.cleanButton, false, "旧回复的 Stop 按钮不能冒充当前请求处理按钮");
  assert.equal(staleMarkersContract.currentStreamingBusy, true, "当前回复真实 streaming 应保持忙碌");
  assert.equal(staleMarkersContract.currentStreamingOnly, true, "弱生成标记与明确 Stop 应分离识别");
  const buttonStateContract = await evaluate(`(()=>{
    const button = document.createElement("button");
    button.id = "composer-submit-button";
    button.setAttribute("aria-label", "Send prompt");
    button.style.cssText = "position:fixed;top:120px;left:32px;width:36px;height:36px";
    button.innerHTML = '<svg class="icon-primary-action" viewBox="0 0 20 20"><path d="M4.5 5.75C4.5 5.05964 5.05964 4.5 5.75 4.5H14.25C14.9404 4.5 15.5 5.05964 15.5 5.75V14.25C15.5 14.9404 14.9404 15.5 14.25 15.5H5.75C5.05964 15.5 4.5 14.9404 4.5 14.25V5.75Z"></path></svg>';
    document.body.appendChild(button);
    const stopIcon = AIInputHistory.requestTimingModel.readComposerButtonState();
    const busyWithIcon = AIInputHistory.requestTimingModel.sampleChatGPT().busy;
    button.querySelector("path").setAttribute("d", "M5 10L10 5L15 10");
    const sendArrow = AIInputHistory.requestTimingModel.readComposerButtonState();
    button.setAttribute("aria-label", "Stop generating");
    const stopLabel = AIInputHistory.requestTimingModel.readComposerButtonState();
    button.setAttribute("aria-label", "Send prompt");
    button.querySelector("svg").innerHTML = '<rect x="5" y="5" width="10" height="10" /><path d="M5 10L10 5L15 10"/>';
    const decorativeSquare = AIInputHistory.requestTimingModel.readComposerButtonState();
    button.querySelector("svg").innerHTML = '<rect x="5" y="5" width="10" height="10" />';
    const stopSquare = AIInputHistory.requestTimingModel.readComposerButtonState();
    button.remove();
    return { stopIcon, busyWithIcon, sendArrow, stopLabel, decorativeSquare, stopSquare };
  })()`);
  assert.equal(buttonStateContract.stopIcon.reason, "composer-stop-icon", "新版方形 Stop 图标应阻止结束计时");
  assert.equal(buttonStateContract.busyWithIcon, true, "Stop 图标应让总体生成状态保持忙碌");
  assert.equal(buttonStateContract.sendArrow.processing, false, "普通发送箭头不能误认为正在处理");
  assert.equal(buttonStateContract.stopLabel.processing, true, "英文 Stop 标签应被识别");
  assert.equal(buttonStateContract.decorativeSquare.processing, false, "附带装饰方块的发送箭头不能误判为 Stop");
  assert.equal(buttonStateContract.stopSquare.reason, "composer-stop-square", "方形 rect Stop 图标应被识别");
  const modernTurnContract = await evaluate(`(()=>{const thread=document.querySelector(".thread");const turn=document.createElement("section");turn.setAttribute("data-turn","assistant");turn.setAttribute("data-turn-id","modern-assistant-turn");turn.textContent="当前 ChatGPT section data-turn 回复";thread.appendChild(turn);const sampled=AIInputHistory.requestTimingModel.sampleChatGPT();turn.remove();return sampled.replies.at(-1)})()`);
  assert.equal(modernTurnContract?.key, "modern-assistant-turn", "当前 section[data-turn=assistant] 结构应被识别为回复");
  assert.equal(modernTurnContract?.nonempty, true, "当前 section[data-turn=assistant] 回复正文应被识别");
  const workLayoutContract = await evaluate(`(()=>{const thread=document.querySelector(".thread");const secondary=document.createElement("div");secondary.setAttribute("data-markdown-text-style","assistant-message");secondary.setAttribute("data-markdown-text-tone","tertiary");secondary.textContent="不应计入回复的辅助文本";thread.appendChild(secondary);const reply=document.createElement("div");reply.setAttribute("data-markdown-text-style","assistant-message");reply.textContent="Team / Work 布局中的真实回复";thread.appendChild(reply);const sampled=AIInputHistory.requestTimingModel.sampleChatGPT();reply.remove();secondary.remove();return sampled.replies.at(-1)})()`);
  assert.equal(workLayoutContract?.nonempty, true, "Team / Work 布局 assistant-message 应被识别为回复");
  assert.equal(workLayoutContract?.activity?.startsWith("20:"), true, "Team / Work 布局应使用真实回复正文生成活动指纹，并排除 tertiary 辅助文本");
  const searchRolloutContract = await evaluate(`(()=>{const thread=document.querySelector(".thread");const unit=document.createElement("section");unit.setAttribute("data-chatgpt-search-unit-key","unit-42:assistant");unit.setAttribute("data-chatgpt-search-message-ids","msg-rollout-42");unit.innerHTML='<div class="markdown" data-markdown-text-style="assistant-message">新版普通会话回复</div>';thread.appendChild(unit);const sampled=AIInputHistory.requestTimingModel.sampleChatGPT();unit.remove();return sampled.replies.at(-1)})()`);
  assert.equal(searchRolloutContract?.key, "msg-rollout-42", "新版普通会话 search-unit assistant 应使用 message ids 作为稳定回复键");
  assert.equal(searchRolloutContract?.nonempty, true, "新版普通会话 search-unit assistant 应识别回复正文");
  const caretRules = await evaluate(`(async()=>{const c=document.querySelector(".composer"); c.style.width="120px"; c.value="这是一段没有换行符但是长度足够触发编辑框自动折行的测试文字用于验证视觉行判断"; c.setSelectionRange(18,18); const wrapped={up:AIInputHistory.InputAdapter.canMoveVertically(c,"up"),down:AIInputHistory.InputAdapter.canMoveVertically(c,"down")}; c.style.width="100%"; c.value="第一行\\n第二行\\n第三行"; c.setSelectionRange(6,6); const middle={up:AIInputHistory.InputAdapter.canMoveVertically(c,"up"),down:AIInputHistory.InputAdapter.canMoveVertically(c,"down")}; const rich=document.createElement("div"); rich.contentEditable="true"; rich.setAttribute("role","textbox"); rich.style.cssText="position:fixed;left:-10000px;top:0;width:120px;white-space:pre-wrap"; rich.textContent="第一行内容\\n第二行内容\\n第三行内容"; document.body.appendChild(rich); rich.focus(); const text=rich.firstChild; const selection=getSelection(); const range=document.createRange(); range.setStart(text,8); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); const richMiddle={up:AIInputHistory.InputAdapter.canMoveVertically(rich,"up"),down:AIInputHistory.InputAdapter.canMoveVertically(rich,"down")}; rich.textContent="继续追问"; rich.focus(); const singleText=rich.firstChild; const singleRange=document.createRange(); singleRange.setStart(singleText,singleText.textContent.length); singleRange.collapse(true); selection.removeAllRanges(); selection.addRange(singleRange); const richSingleUp=AIInputHistory.InputAdapter.canMoveVertically(rich,"up"); singleRange.setStart(singleText,0); singleRange.collapse(true); selection.removeAllRanges(); selection.addRange(singleRange); const richSingleDown=AIInputHistory.InputAdapter.canMoveVertically(rich,"down"); rich.remove(); c.focus(); c.setSelectionRange(6,6); let leaked=0; document.addEventListener("keydown",(event)=>{if(event.key==="ArrowUp")leaked+=1},{capture:true,once:true}); c.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true})); await new Promise((resolve)=>setTimeout(resolve,80)); const middleText=c.value; c.setSelectionRange(0,0); const firstUp=AIInputHistory.InputAdapter.canMoveVertically(c,"up"); c.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true})); await new Promise((resolve)=>setTimeout(resolve,80)); return {wrapped,middle,richMiddle,richSingleUp,richSingleDown,firstUp,leaked,middleText,historyText:c.value}})()`);
  assert.deepEqual(caretRules.wrapped, { up: true, down: true }, "textarea 自动折行也应按视觉行判断上下边界");
  assert.deepEqual(caretRules.middle, { up: true, down: true }, "多行输入中间行应保留上下行移动");
  assert.deepEqual(caretRules.richMiddle, { up: true, down: true }, "contenteditable/ProseMirror 类输入框中间行也应保留上下行移动");
  assert.equal(caretRules.richSingleUp, false, "单行 contenteditable 行尾 ArrowUp 不应误判成上一视觉行");
  assert.equal(caretRules.richSingleDown, false, "单行 contenteditable 行首 ArrowDown 不应误判成下一视觉行");
  assert.equal(caretRules.firstUp, false, "第一行不能再向上移动时才允许切历史");
  assert.equal(caretRules.middleText, "第一行\n第二行\n第三行", "中间行 ArrowUp 不得切换历史");
  assert.equal(caretRules.leaked, 0, `方向键不能继续传播给页面自己的快捷键处理器; browserEvents=${JSON.stringify(browserEvents.slice(-14))}; state=${JSON.stringify(await evaluate(`({loaded:__aiInputHistoryLoaded,root:!!document.querySelector("[data-ai-input-history='root']"),sidebar:!!AIInputHistory.SidebarTiming,current:location.pathname})`))}`);
  assert.notEqual(caretRules.historyText, caretRules.middleText, "第一行 ArrowUp 应切换到历史记录");
  await evaluate(`(()=>{
    const selector=document.createElement("button");
    selector.type="button";
    selector.setAttribute("data-testid","model-switcher-dropdown-button");
    selector.textContent="GPT-6 Pro";
    selector.id="aih-pro-picker-fixture";
    document.querySelector(".composer-wrap").appendChild(selector);
    return true
  })()`);
  assert.equal(await evaluate(`AIInputHistory.proUsageModel.detect()?.id`),"gpt-6-pro",
    "测试页应识别明确选择的 GPT-6 Pro，而不是账号订阅身份");
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(50)'`);
  assert.equal(await evaluate(`document.querySelector('[data-aih-pro-remaining]')?.title`), "",
    "新设计不应显示额外的插件说明气泡");
  assert.equal(await evaluate(`document.querySelector('[data-aih-pro-remaining]')?.getAttribute('data-aih-pro-source')`),
    "estimated", "仍保留估算来源内部状态，避免改变统计逻辑");
  await evaluate(`(()=>{const c=document.querySelector(".composer"); c.value="计时验收"; c.dispatchEvent(new Event("input",{bubbles:true})); return true})()`);
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot; if(root.querySelector(".panel").classList.contains("hidden")) root.querySelector(".launcher").click(); document.querySelector(".send").click(); return true})()`);
  await sleep(1200);
  const running = await evaluate(`(()=>{const l=document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher"); return {active:l.classList.contains("timing-active"),clock:l.querySelector(".request-clock").textContent}})()`);
  assert.equal(running.active, true, `发送后悬浮按钮应进入计时状态；页面状态=${JSON.stringify(await evaluate(`({settings:__testMemory.aiInputHistorySettings,entries:__testMemory.aiInputHistoryState.entries.slice(0,5),profile:AIInputHistory.SiteProfiles.forSite(location.hostname)?.id||null,sample:AIInputHistory.requestTimingModel.sampleChatGPT()})`))}；浏览器事件=${JSON.stringify(browserEvents.slice(-8))}`);
  assert.match(running.clock, /^\d+s$/, "悬浮按钮应显示当前请求秒数");
  await waitFor(`__testMemory.aiInputHistoryProUsage?.models?.["gpt-6-pro"]?.total===1`);
  assert.equal(await evaluate(`Object.keys(__testMemory.aiInputHistoryProUsage.requestIds).length`), 1,
    "计时开始时 Pro 新请求应被计入一次");
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(49)'`);
  const startedBeforeReopen = await evaluate(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="计时验收")?.requestTiming?.startedAt`);
  await send("Page.navigate", { url: "about:blank" });
  await waitFor(`location.href === "about:blank"`);
  await sleep(300);
  await send("Page.navigate", { url: targetUrl });
  await waitFor(`location.href.includes("screenshot-fixture.html") && Boolean(document.querySelector("[data-ai-input-history='root']")?.shadowRoot?.querySelector(".launcher"))`);
  await sleep(1000);
  const afterReopen = await evaluate(`(()=>{const l=document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher"); const entry=__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="计时验收"); return {active:l.classList.contains("timing-active"),clock:l.querySelector(".request-clock").textContent,startedAt:entry?.requestTiming?.startedAt}})()`);
  assert.equal(afterReopen.active, true, "离开页面后重新打开同一会话 URL 应恢复正在进行的计时");
  assert.equal(afterReopen.startedAt, startedBeforeReopen, "重新打开同一 URL 后应保留最初发送时间");
  assert.match(afterReopen.clock, /^\d+s$/, "重新打开同一 URL 后悬浮按钮应继续显示累计秒数");
  assert.equal(await evaluate(`__testMemory.aiInputHistoryProUsage?.models?.["gpt-6-pro"]?.total`),1,
    "刷新恢复相同 requestId 不能额外增加 Pro 使用次数");
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await sleep(1400);
  const finalState = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot; const entry=__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="计时验收"); const row=[...root.querySelectorAll(".entry-row")].find((item)=>item.textContent.includes("计时验收")); return {timing:entry?.requestTiming||null,launcherActive:root.querySelector(".launcher").classList.contains("timing-active"),timingText:row?.querySelector(".reply-timing")?.textContent||"",preciseTime:row?.querySelector(".time-precise")?.textContent||""}})()`);
  assert.equal(finalState.timing?.status, "completed", "模拟回复完成后应保存 completed 状态");
  assert.ok(Number.isFinite(finalState.timing?.durationMs) && finalState.timing.durationMs > 0, "应保存正数总耗时");
  assert.ok(finalState.timing.completedAt >= finalState.timing.startedAt, "回复完成时间不得早于发送时间");
  assert.equal(finalState.launcherActive, false, "回复完成后悬浮按钮应恢复历史图标");
  assert.match(finalState.timingText, /总耗时/, "历史行应显示总耗时");
  assert.match(finalState.timingText, /回复完成/, "历史行应显示 GPT 回复完成时间");
  assert.match(finalState.preciseTime, /\d{1,2}:\d{2}:\d{2}/, "历史行应保留精确到秒的发送时间");
  const notificationsAfterText = await evaluate(`__testNotificationMessages.map((item)=>item.event?.promptText)`);
  assert.deepEqual(notificationsAfterText, ["计时验收"], "真实回复完成应向后台发送一次完成通知事件");

  await evaluate(`(()=>{const c=document.querySelector(".composer"); const send=document.querySelector(".send"); c.value="hello"; c.dispatchEvent(new Event("input",{bubbles:true})); send.click(); document.querySelector('[data-testid="stop-button"]')?.remove(); send.disabled=true; return true})()`);
  await sleep(2200);
  const earlyFastReply = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot; const entry=__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="hello"); return {timing:entry?.requestTiming||null,launcherActive:root.querySelector(".launcher").classList.contains("timing-active")}})()`);
  assert.notEqual(earlyFastReply.timing?.status, "completed", "未采到 stop/action 时，回复短暂停顿几秒不能提前结束计时");
  assert.equal(earlyFastReply.launcherActive, true, "保守兜底等待期间悬浮计时应继续运行");
  await sleep(8500);
  const fastReply = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot; const entry=__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="hello"); return {timing:entry?.requestTiming||null,launcherActive:root.querySelector(".launcher").classList.contains("timing-active"),notifications:__testNotificationMessages.map((item)=>item.event?.promptText),sample:AIInputHistory.requestTimingModel.sampleChatGPT(),sessions:JSON.parse(localStorage.getItem("aih-fixture-timings")||"{}")}})()`);
  assert.equal(fastReply.timing?.status, "completed", `未采到 stop/send/action 信号时，回复稳定 10 秒后才使用兜底完成；状态=${JSON.stringify(fastReply)}`);
  assert.equal(fastReply.launcherActive, false, "超快回复稳定后应结束计时");
  assert.deepEqual(fastReply.notifications, ["计时验收", "hello"], "超快回复完成后也必须发出完成通知事件");
  assert.equal(await evaluate(`__testMemory.aiInputHistoryProUsage?.models?.["gpt-6-pro"]?.total`),1,
    "切换回普通模型后的新请求不应消耗 Pro 计数");
  await evaluate(`(document.querySelector(".send").disabled=false,true)`);

  // Regression from a real report: the current ChatGPT page must finish a reply,
  // not leave it paused simply because completed replies contain extra toolbar buttons.
  await evaluate(`(()=>{
    const c=document.querySelector(".composer");c.value="普通工具按钮不应触发暂停";c.dispatchEvent(new Event("input",{bubbles:true}));
    document.querySelector(".send").click();
    const article=document.querySelector(".thread article:last-child");
    article.insertAdjacentHTML("beforeend",'<button aria-label="More actions" type="button">More</button><button aria-label="View sources" type="button">Sources</button>');
    return true})()`);
  await waitFor(`Boolean(document.querySelector('[data-testid="stop-button"]'))`);
  assert.equal(await evaluate(`AIInputHistory.requestTimingModel.sampleChatGPT().waitingForSelection`), false,
    "普通回复的 More/Sources 工具按钮不得触发选择暂停");
  await evaluate(`(()=>{
    [...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click();
    const article=document.querySelector(".thread article:last-child");
    article.querySelector('[data-message-author-role="assistant"]').textContent="普通完整回答";
    article.insertAdjacentHTML("beforeend",'<button aria-label="Copy response" type="button">复制回复</button>');
    return true})()`);
  await waitFor(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="普通工具按钮不应触发暂停")?.requestTiming?.status==="completed"`);
  assert.equal(await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`),false,
    "当前页面回复完成后计时数字应消失");

  // Even if a weak/heuristic choice was recorded during generation, the same
  // page's explicit completed reply must revoke the false pause and finalize.
  await evaluate(`(()=>{
    const c=document.querySelector(".composer");c.value="误暂停必须恢复完成";c.dispatchEvent(new Event("input",{bubbles:true}));
    document.querySelector(".send").click();
    const article=document.querySelector(".thread article:last-child");
    article.querySelector('[data-message-author-role="assistant"]').textContent="Please choose one option to continue";
    article.insertAdjacentHTML("beforeend",'<button type="button">Option Alpha</button><button type="button">Option Beta</button>');
    return true})()`);
  await waitFor(`Object.values(__testMemory.aiInputHistoryActiveTimingByUrl||{}).some((item)=>item.completionContext?.promptText==="误暂停必须恢复完成"&&Number.isFinite(item.pausedAt))`);
  const mistakenSelection = await evaluate(`AIInputHistory.requestTimingModel.sampleChatGPT().selectionKind`);
  assert.equal(mistakenSelection,"inferred");
  await evaluate(`(()=>{
    [...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click();
    const article=document.querySelector(".thread article:last-child");
    article.querySelector('[data-message-author-role="assistant"]').textContent="Please choose one option to continue. Answer delivered.";
    article.insertAdjacentHTML("beforeend",'<button aria-label="Copy response" type="button">复制回复</button>');
    return true})()`);
  await waitFor(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="误暂停必须恢复完成")?.requestTiming?.status==="completed"`);
  assert.equal(await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`),false,
    "误暂停后回复已完成，必须结束而非停在暂停");
  const tentativeRecovery = await evaluate(`({
    log:__testTimingDebugMessages.some((entry)=>entry.stage==="timing-false-selection-recovered"),
    duration:__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="误暂停必须恢复完成")?.requestTiming?.durationMs
  })`);
  assert.equal(tentativeRecovery.log,true,"误暂停撤销应有诊断日志");
  assert.ok(tentativeRecovery.duration>0,"误暂停期间不能令耗时归零");

  const historyCount = await evaluate(`__testMemory.aiInputHistoryState.entries.length`);
  await evaluate(`(()=>{const c=document.querySelector(".composer"); c.value=""; c.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector(".send").click(); return true})()`);
  await sleep(800);
  const imageOnly = await evaluate(`(()=>{const l=document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher"); return {active:l.classList.contains("timing-active"),count:__testMemory.aiInputHistoryState.entries.length}})()`);
  assert.equal(imageOnly.active, true, "纯图片/附件、无文本时点击发送按钮也应开始计时");
  assert.equal(imageOnly.count, historyCount, "无文本请求不应伪造输入历史记录");
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await sleep(1200);
  assert.equal(await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`), false, "纯图片/附件回复完成后应恢复历史图标");

  await evaluate(`(()=>{const c=document.querySelector(".composer");const send=document.querySelector(".send");c.value="空闲直接发送";c.dispatchEvent(new Event("input",{bubbles:true}));send.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,cancelable:true,button:0,isPrimary:true}));send.click();return true})()`);
  await waitFor(`__testMemory.aiInputHistoryState.entries.some((item)=>item.text==="空闲直接发送") && Boolean(document.querySelector('[data-testid="stop-button"]'))`);
  const queueIntentWhileBusy = await evaluate(`(()=>{const intent=document.querySelector("[data-ai-input-queue='root']")?.shadowRoot?.querySelector('[data-queue-intent]');return {visible:Boolean(intent)&&!intent.classList.contains('hidden'),text:intent?.textContent||''}})()`);
  assert.equal(queueIntentWhileBusy.visible, true, "当前回复未结束、下一条会进入 Queue 时必须提前显示状态标识");
  assert.equal(queueIntentWhileBusy.text, "下一条将加入队列");
  const idleDirect = await evaluate(`({queued:Object.values(__testMemory.aiInputHistoryPromptQueues||{}).flat().some((item)=>item.text==="空闲直接发送"),composer:document.querySelector('.composer').value})`);
  assert.equal(idleDirect.queued, false, "当前没有等待 GPT 回复时，物理点击发送不得进入 Queue");
  assert.equal(idleDirect.composer, "", "空闲状态应直接由 ChatGPT 消费输入内容");
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await sleep(700);
  const queueIntentAfterComplete = await evaluate(`(()=>{const intent=document.querySelector("[data-ai-input-queue='root']")?.shadowRoot?.querySelector('[data-queue-intent]');return Boolean(intent)&&!intent.classList.contains('hidden')})()`);
  assert.equal(queueIntentAfterComplete, false, "回复结束、下一条恢复直接发送后状态标识应立即消失");

  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="Queue 基准请求";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await waitFor(`Boolean(document.querySelector('[data-testid="stop-button"]'))`);
  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="排队消息一";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await sleep(250);
  const queuedBeforeEdit = await evaluate(`(()=>{const q=__testMemory.aiInputHistoryPromptQueues||{};const items=Object.values(q)[0]||[];const root=document.querySelector("[data-ai-input-queue='root']")?.shadowRoot;return {items,visible:!root?.querySelector('.queue')?.classList.contains('hidden'),sendNow:Boolean(root?.querySelector('[data-action="send-now"]'))}})()`);
  assert.equal(queuedBeforeEdit.items.length, 1, "回复进行中再次发送应进入队列而不是立即发送");
  assert.equal(queuedBeforeEdit.items[0]?.text, "排队消息一");
  assert.equal(queuedBeforeEdit.visible, true, "排队后应显示队列面板");
  assert.equal(queuedBeforeEdit.sendNow, true, "每条 Queue 消息都应提供立即发送按钮");

  const historyAfterTyping = await evaluate(`(async()=>{const c=document.querySelector(".composer");const pause=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));c.value="手动输入一次";c.dispatchEvent(new Event("input",{bubbles:true}));const values=[];for(let i=0;i<3;i+=1){c.focus();c.setSelectionRange(0,0);c.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true}));await pause(120);values.push(c.value)}c.value="";c.dispatchEvent(new Event("input",{bubbles:true}));return values})()`);
  assert.equal(new Set(historyAfterTyping).size, 3, "手动输入过一次后连续 ArrowUp 仍应持续切换历史");

  const historyWithQueue = await evaluate(`(async()=>{const c=document.querySelector(".composer");const pause=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));const pick=async()=>{c.focus();c.setSelectionRange(0,0);c.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true}));await pause(120);return c.value};const enqueue=async()=>{c.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));await pause(180)};const first=await pick();await enqueue();const second=await pick();await enqueue();const third=await pick();c.value="";c.dispatchEvent(new Event("input",{bubbles:true}));const root=document.querySelector("[data-ai-input-queue='root']").shadowRoot;for(const text of [first,second]){const row=[...root.querySelectorAll('.item')].find((item)=>item.querySelector('.text')?.textContent===text);row?.querySelector('[data-action="remove"]')?.click();await pause(180);c.value="";c.dispatchEvent(new Event("input",{bubbles:true}))}return {first,second,third,queue:(Object.values(__testMemory.aiInputHistoryPromptQueues||{})[0]||[]).map((item)=>item.text)}})()`);
  assert.ok(historyWithQueue.first && historyWithQueue.second && historyWithQueue.third, "Queue 存在时应能连续取出前三条历史");
  assert.equal(new Set([historyWithQueue.first, historyWithQueue.second, historyWithQueue.third]).size, 3, "每次 Queue 入队后 ArrowUp 都应继续到更老历史，而不是重置游标");
  assert.deepEqual(historyWithQueue.queue, ["排队消息一"], "连续历史导航验收结束后只保留原始 Queue 项");

  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-queue='root']").shadowRoot;root.querySelector('[data-action="edit"]').click();const editor=root.querySelector('textarea[data-editor]');editor.value="排队消息一（已编辑）";root.querySelector('[data-action="save"]').click();return true})()`);
  await sleep(180);
  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="准备撤回的消息";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await sleep(180);
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-queue='root']").shadowRoot;const buttons=[...root.querySelectorAll('[data-action="remove"]')];buttons.at(-1)?.click();return true})()`);
  await sleep(180);
  const queueAfterEditRemove = await evaluate(`({queue:Object.values(__testMemory.aiInputHistoryPromptQueues||{})[0]||[],composer:document.querySelector('.composer').value})`);
  assert.deepEqual(queueAfterEditRemove.queue.map((item) => item.text), ["排队消息一（已编辑）"], "撤回后 Queue 应只保留未撤回消息");
  assert.equal(queueAfterEditRemove.composer, "准备撤回的消息", "撤回必须把消息内容放回输入框");
  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="排队消息二";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await sleep(180);
  assert.deepEqual((await evaluate(`(Object.values(__testMemory.aiInputHistoryPromptQueues||{})[0]||[]).map((item)=>item.text)`)), ["排队消息一（已编辑）", "排队消息二"], "多条消息应按 FIFO 顺序排队");

  await evaluate(`(globalThis.__AIH_TEST_IGNORE_NEXT_SEND=true,true)`);
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await waitFor(`(Object.values(__testMemory.aiInputHistoryPromptQueues||{})[0]||[]).length===1 && Boolean(document.querySelector('[data-testid="stop-button"]'))`);
  await sleep(250);
  const firstDispatch = await evaluate(`({queue:(Object.values(__testMemory.aiInputHistoryPromptQueues||{})[0]||[]).map((item)=>item.text),busy:Boolean(document.querySelector('[data-testid="stop-button"]')),composer:document.querySelector('.composer').value,secondSent:__testMemory.aiInputHistoryState.entries.some((item)=>item.text==="排队消息二"),ignored:globalThis.__AIH_TEST_IGNORED_SENDS||0,voiceClicks:globalThis.__AIH_TEST_VOICE_CLICKS||0,firstHistoryCount:__testMemory.aiInputHistoryState.entries.filter((item)=>item.text==="排队消息一（已编辑）").length,userSent:[...document.querySelectorAll('[data-message-author-role="user"]')].some((item)=>item.textContent.trim()==="排队消息一（已编辑）")})`);
  assert.deepEqual(firstDispatch.queue, ["排队消息二"], "第一条自动发送后第二条必须继续等待");
  assert.equal(firstDispatch.secondSent, false, "上一条的新回复未结束前不得发送第二条队列消息");
  assert.equal(firstDispatch.busy, true, "第一条自动发送后应进入下一轮生成状态");
  assert.equal(firstDispatch.composer, "", "自动发送成功后输入框应清空");
  assert.equal(firstDispatch.ignored, 1, "第一次自动 click 被页面忽略后应继续重试而不是丢 Queue");
  assert.equal(firstDispatch.voiceClicks, 0, "Queue 自动发送绝不能误点语音/麦克风按钮");
  assert.equal(firstDispatch.userSent, true, "只有会话中真正出现对应 user turn 才能认为 Queue 已发送成功");
  assert.equal(firstDispatch.firstHistoryCount, 1, "自动重试不应重复写入发送历史");

  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await waitFor(`(Object.values(__testMemory.aiInputHistoryPromptQueues||{})[0]||[]).length===0 && Boolean(document.querySelector('[data-testid="stop-button"]'))`);
  await sleep(120);
  const secondDispatch = await evaluate(`({queue:Object.values(__testMemory.aiInputHistoryPromptQueues||{})[0]||[],busy:Boolean(document.querySelector('[data-testid="stop-button"]'))})`);
  assert.equal(secondDispatch.queue.length, 0, "第二轮结束后第二条排队消息才应自动发送");
  assert.equal(secondDispatch.busy, true, "第二条自动发送后应进入新的生成状态");
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await sleep(700);

  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="右键停止计时测试";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await waitFor(`Boolean(document.querySelector('[data-testid="stop-button"]')) && document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`);
  const launcherMenu = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot;const launcher=root.querySelector('.launcher');launcher.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:60,clientY:60}));const menu=root.querySelector('.launcher-menu');const buttons=[...menu.querySelectorAll('button')];return {visible:!menu.classList.contains('hidden'),labels:buttons.map((b)=>b.textContent.trim()),stopDisabled:buttons.find((b)=>b.dataset.launcherAction==='stop')?.disabled===true}})()`);
  assert.equal(launcherMenu.visible, true, "右键悬浮计时应打开菜单而不是直接隐藏");
  assert.deepEqual(launcherMenu.labels, ["隐藏悬浮按钮", "禁用队列", "停止计时"], "右键菜单应提供隐藏、Queue 开关和停止计时");
  assert.equal(launcherMenu.stopDisabled, false, "正在计时时停止计时菜单必须可用");
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot;root.querySelector('[data-launcher-action="stop"]').click();return true})()`);
  await waitFor(`!document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`);
  const stoppedTiming = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot;const entry=__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="右键停止计时测试");return {status:entry?.requestTiming?.status||null,launcherHidden:root.querySelector('.launcher').classList.contains('hidden')}})()`);
  assert.equal(stoppedTiming.status, "cancelled", "停止计时应保存 cancelled 状态");
  assert.equal(stoppedTiming.launcherHidden, false, "停止计时不能同时隐藏悬浮按钮");

  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history=\'root\']").shadowRoot;const launcher=root.querySelector(".launcher");launcher.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:60,clientY:60}));root.querySelector("[data-launcher-action=\'queue\']").click();return true})()`);
  await waitFor(`__testMemory.aiInputHistorySettings.queueEnabled===false`);
  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="禁用队列直发";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await waitFor(`[...document.querySelectorAll(\'[data-message-author-role="user"]\')].some((item)=>item.textContent.trim()==="禁用队列直发")`);
  const disabledQueueDirect = await evaluate(`(()=>{const queueItems=Object.values(__testMemory.aiInputHistoryPromptQueues||{}).flat();const queueRoot=document.querySelector("[data-ai-input-queue=\'root\']")?.shadowRoot;const section=queueRoot?.querySelector(".queue");const intent=queueRoot?.querySelector("[data-queue-intent]");return {queued:queueItems.some((item)=>item.text==="禁用队列直发"),composer:document.querySelector(".composer").value,queueVisible:Boolean(section)&&!section.classList.contains("hidden"),intentVisible:Boolean(intent)&&!intent.classList.contains("hidden")}})()`);
  assert.equal(disabledQueueDirect.queued, false, "禁用 Queue 后回复进行中发送也不能加入队列");
  assert.equal(disabledQueueDirect.composer, "", "禁用 Queue 后应直接交给 ChatGPT 消费输入");
  assert.equal(disabledQueueDirect.queueVisible, false, "禁用 Queue 时已有 Queue 面板应隐藏");
  assert.equal(disabledQueueDirect.intentVisible, false, "禁用 Queue 时不应显示下一条入队提示");
  const disabledMenu = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history=\'root\']").shadowRoot;const launcher=root.querySelector(".launcher");launcher.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:60,clientY:60}));return root.querySelector("[data-launcher-action=\'queue\']").textContent.trim()})()`);
  assert.equal(disabledMenu, "启用队列", "禁用后右键菜单应切换为启用队列");
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history=\'root\']").shadowRoot;root.querySelector("[data-launcher-action=\'queue\']").click();return true})()`);
  await waitFor(`__testMemory.aiInputHistorySettings.queueEnabled===true`);
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history=\'root\']").shadowRoot;const launcher=root.querySelector(".launcher");launcher.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:60,clientY:60}));root.querySelector("[data-launcher-action=\'stop\']")?.click();return true})()`);
  await sleep(120);

  // A real content script should park A when SPA navigation switches to B, not cancel it.
  await evaluate(`(()=>{[...document.querySelectorAll("button")].find((item)=>item.textContent==="模拟回复完成")?.click();document.querySelectorAll(".thread article").forEach((item)=>item.remove());history.pushState({},"","/c/parallel-A");return true})()`);
  await sleep(700);
  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="并行会话 A";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await waitFor(`Boolean(JSON.parse(localStorage.getItem("aih-fixture-timings")||"{}")["127.0.0.1::conversation:parallel-A"])`);
  await evaluate(`(()=>{history.pushState({},"","/c/parallel-B");document.querySelectorAll(".thread article").forEach((item)=>item.remove());return true})()`);
  await sleep(650);
  const switchedA = await evaluate(`(()=>({parked:Boolean(JSON.parse(localStorage.getItem("aih-fixture-timings")||"{}")["127.0.0.1::conversation:parallel-A"]),visible:document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")}))()`);
  assert.equal(switchedA.parked, true, "SPA 切走会话 A 时必须保存 A 的计时状态");
  assert.equal(switchedA.visible, false, "浏览会话 B 时不能显示 A 的悬浮计时");
  await evaluate(`(()=>{const c=document.querySelector(".composer");c.value="并行会话 B";c.dispatchEvent(new Event("input",{bubbles:true}));document.querySelector(".send").click();return true})()`);
  await waitFor(`Object.keys(JSON.parse(localStorage.getItem("aih-fixture-timings")||"{}")).filter((key)=>key.includes("::conversation:parallel-")).length===2`);
  // Route updates can precede React hydration: first return to A while B's
  // completed transcript is still mounted. B must never complete A's timer.
  await evaluate(`(()=>{history.pushState({},"","/c/parallel-A");document.querySelector('[data-testid="stop-button"]')?.remove();document.querySelector(".thread").insertAdjacentHTML("beforeend",'<button aria-label="Copy response">B 复制</button>');return true})()`);
  await sleep(1300);
  const beforeAContentReady = await evaluate(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="并行会话 A")?.requestTiming?.status`);
  assert.equal(beforeAContentReady, "pending", "切回 A 的 URL 但仍显示 B 已完成的正文时，不能误结束 A");
  await evaluate(`(()=>{document.querySelector(".thread").innerHTML='<article><div data-message-author-role="user" data-message-id="asked-A">并行会话 A</div></article><article><div data-message-author-role="assistant" data-message-id="completed-A">A 已完成</div><button aria-label="Copy response">复制</button></article>';return true})()`);
  await waitFor(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="并行会话 A")?.requestTiming?.status==="completed"`);
  const waitingB = await evaluate(`Boolean(JSON.parse(localStorage.getItem("aih-fixture-timings")||"{}")["127.0.0.1::conversation:parallel-B"])`);
  assert.equal(waitingB, true, "A 完成不会删除 B 的独立计时记录");
  await evaluate(`(()=>{history.pushState({},"","/c/parallel-B");document.querySelector(".thread").innerHTML='<article><div data-message-author-role="user" data-message-id="asked-B">并行会话 B</div></article><article><div data-message-author-role="assistant" data-message-id="completed-B">B 已完成，没有复制按钮</div></article>';return true})()`);
  await waitFor(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="并行会话 B")?.requestTiming?.status==="completed"`);
  const independentTimings = await evaluate(`(()=>["并行会话 A","并行会话 B"].map((text)=>({text,timing:__testMemory.aiInputHistoryState.entries.find((item)=>item.text===text)?.requestTiming})))()`);
  assert.equal(independentTimings.length, 2);
  assert.ok(independentTimings.every((item)=>item.timing?.durationMs>0), "两个会话应各自记录完成耗时");
  assert.deepEqual(independentTimings.map((item)=>item.timing.conversationId), ["parallel-A","parallel-B"], "最终历史记录应存入对应的 ChatGPT 会话 ID");
  assert.equal(independentTimings[0].timing.observedAfterResume, true, "A 在返回会话后才观察到完成，应标注为耗时上限");

  // Interactive assistant choices must freeze the current clock until a real choice is clicked.
  await evaluate(`(()=>{history.pushState({},"","/c/choice-flow");document.querySelector(".thread").innerHTML="";
    const c=document.querySelector(".composer");c.value="选项暂停流程";c.dispatchEvent(new Event("input",{bubbles:true}));
    document.querySelector(".send").click();return true})()`);
  await waitFor(`Boolean(__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:choice-flow'])`);
  await evaluate(`(()=>{const answer=document.querySelector('.thread article:last-child [data-message-author-role="assistant"]');
    answer.insertAdjacentHTML("beforeend",'<div class="choice-options"><button type="button" data-testid="choice-yes">继续执行</button><button type="button" data-testid="choice-no">取消执行</button></div>');
    return true})()`);
  await waitFor(`Number.isFinite(__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:choice-flow']?.pausedAt)`);
  await waitFor(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".request-clock").textContent.includes("⏸")`);
  const frozenChoice = await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".request-clock").textContent`);
  await sleep(1300);
  assert.equal(await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".request-clock").textContent`), frozenChoice, "交互式选项等待期间计时必须暂停");
  await evaluate(`(()=>{document.querySelector('[data-testid="choice-yes"]').click();document.querySelector('.choice-options')?.remove();return true})()`);
  await waitFor(`__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:choice-flow']?.pausedAt===null`);
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await waitFor(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="选项暂停流程")?.requestTiming?.status==="completed"`);

  // Dedicated sidebar acceptance: recent/project aliases share one conversation clock,
  // an explicit waiting marker freezes it, and a new unread marker removes both badges.
  await evaluate(`(()=>{
    const side=document.querySelector(".side");
    const wrapper=document.createElement("section");
    wrapper.id="sidebar-clock-check";
    wrapper.innerHTML='<a href="/c/sidebar-alpha" data-aih-test-status="running">最近：计时任务</a><div class="project"><a href="/g/demo/c/sidebar-alpha">项目：计时任务</a></div>';
    side.appendChild(wrapper);
    const entry={id:"sidebar-entry",kind:"send",text:"侧边栏任务",site:location.hostname,createdAt:Date.now()-33000,
      requestTiming:{status:"pending",startedAt:Date.now()-33000}};
    __testMemory.aiInputHistoryState.entries.push(entry);
    const state={requestId:"sidebar-request",site:location.hostname,path:"/c/sidebar-alpha",conversationId:"sidebar-alpha",
      entryId:"sidebar-entry",startedAt:entry.createdAt,pausedAt:null,pausedDurationMs:0,pauseVersion:0,
      sidebarUnreadCleared:true,completionContext:{promptText:"侧边栏任务"}};
    chrome.runtime.sendMessage({type:"AIH_TIMING_SESSION_SAVE",state},()=>{});
    return true
  })()`);
  await waitFor(`document.querySelectorAll('#sidebar-clock-check [data-aih-sidebar-timer]').length===2`);
  const sidebarInitial = await evaluate(`[...document.querySelectorAll('#sidebar-clock-check [data-aih-sidebar-timer]')].map((node)=>node.textContent)`);
  assert.equal(sidebarInitial.length, 2);
  assert.equal(sidebarInitial[0], sidebarInitial[1], "项目与最近会话中相同 ID 必须共享数字");
  // Manual fallback for ChatGPT states not exposed by the sidebar:
  // right-click the number, verify cross-tab storage freeze and explicit resume.
  await evaluate(`(()=>{const badge=document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]');
    badge.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));return true})()`);
  await waitFor(`__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:sidebar-alpha']?.manualPause===true`);
  await waitFor(`document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]')?.textContent.startsWith('⏸ ')`);
  const manualFrozen = await evaluate(`document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]').textContent`);
  await sleep(1300);
  assert.equal(await evaluate(`document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]').textContent`),manualFrozen,
    "即使外层仍显示运行，手动暂停也必须冻结秒数");
  await evaluate(`(()=>{const badge=document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]');
    badge.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2}));return true})()`);
  await waitFor(`__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:sidebar-alpha']?.manualPause===false`);
  await waitFor(`!document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]')?.textContent.startsWith('⏸ ')`);
  // A sibling status indicator overrides an old "running" attribute on the link.
  await evaluate(`(()=>{document.querySelector('#sidebar-clock-check').insertAdjacentHTML('beforeend',
    '<span id="sidebar-waiting-status" role="status" aria-label="Waiting for your input"></span>');return true})()`);

  await waitFor(`Number.isFinite(__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:sidebar-alpha']?.pausedAt)`);
  await waitFor(`document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]')?.textContent.startsWith('⏸ ')`);
  const frozen = await evaluate(`document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]').textContent`);
  await sleep(1400);
  assert.equal(await evaluate(`document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]').textContent`), frozen, "等待选择期间计时数字应冻结");
  await evaluate(`(()=>{document.querySelector('#sidebar-waiting-status')?.remove();return true})()`);
  await waitFor(`__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:sidebar-alpha']?.pausedAt===null`);
  await waitFor(`!document.querySelector('#sidebar-clock-check [data-aih-sidebar-timer]')?.textContent.startsWith('⏸ ')`);
  await evaluate(`(()=>{document.querySelector('#sidebar-clock-check a').setAttribute('data-aih-test-status','completed');return true})()`);
  await waitFor(`!__testMemory.aiInputHistoryActiveTimingByUrl['127.0.0.1::conversation:sidebar-alpha']`);
  assert.equal(await evaluate(`document.querySelectorAll('#sidebar-clock-check [data-aih-sidebar-timer]').length`), 0, "后台任务完成后，最近列表和项目列表的数字都必须消失");
  assert.equal(await evaluate(`__testMemory.aiInputHistoryState.entries.find((item)=>item.id==='sidebar-entry')?.requestTiming?.confirmedFromSidebar`), true, "完成应持久化为来自侧边栏的确认");

  const browserTimingDiagnostics = await evaluate(`globalThis.__testTimingDebugMessages || []`);
  assert.ok(browserTimingDiagnostics.some((item) => item.stage === "timing-observer-suspended"),
    "真实浏览器切换会话时应通过内容脚本记录观察挂起日志");
  assert.ok(browserTimingDiagnostics.some((item) => item.stage === "timing-observer-restored"),
    "真实浏览器恢复会话时应通过内容脚本记录观察恢复日志");
  assert.equal(browserTimingDiagnostics.some((item) => Object.hasOwn(item, "promptText") || Object.hasOwn(item, "responseText")), false,
    "浏览器计时日志不能发送问题或回答正文");

  // Real content-script message path: read only a classified plan from an
  // authenticated first-party session and the selected workspace entry.
  // Never return the access token or workspace identifiers to the popup.
  const accountRead = await evaluate(`new Promise((resolve)=>{
    const originalFetch=window.fetch;
    window.fetch=async(url,options)=>{
      if(url==="/api/auth/session") return new Response(JSON.stringify({
        accessToken:"SECRET_BROWSER_FIXTURE_ACCESS_TOKEN_123456",
        account:{id:"selected-business-workspace"}
      }),{status:200,headers:{"content-type":"application/json"}});
      if(url==="/backend-api/accounts/check/v4-2023-04-27") return new Response(JSON.stringify({
        accounts:{
          personal:{account:{plan_type:"free"}},
          "selected-business-workspace":{account:{plan_type:"business_standard"}}
        }
      }),{status:200,headers:{"content-type":"application/json"}});
      return originalFetch(url,options);
    };
    const listener=__testRuntimeListeners.find((listener)=>listener(
      {type:"AIH_PRO_ACCOUNT_PLAN_READ"},{},(value)=>{
        window.fetch=originalFetch;
        resolve(value);
      })===true);
    if(!listener){window.fetch=originalFetch;resolve({ok:false,reason:"listener-missing"})}
  })`);
  assert.equal(accountRead?.ok,true,"当前 ChatGPT 账号读取消息链路应该通畅");
  assert.equal(accountRead?.plan,"business-standard",
    "包含个人与 Business 两种工作区时必须选中当前的 Business 套餐");
  assert.equal(accountRead?.source,"chatgpt-account-list");
  assert.doesNotMatch(JSON.stringify(accountRead),/SECRET_BROWSER|accessToken|selected-business-workspace/,
    "弹窗只应收到脱敏后的套餐分类，不包含登录凭据和账号 ID");

  // More realistic Business response: workspace plan_type is only "business".
  // The member list contains the actual, current user's premium seat.
  const seatRead = await evaluate(`new Promise((resolve)=>{
    const originalFetch=window.fetch;
    window.fetch=async(url,options)=>{
      if(url==="/api/auth/session")return new Response(JSON.stringify({
        accessToken:"SECRET_PREMIUM_BROWSER_FIXTURE_TOKEN_123",
        user:{id:"test-current-user",email:"current@example.invalid"},
        account:{id:"selected-business-workspace"}
      }),{status:200,headers:{"content-type":"application/json"}});
      if(url==="/backend-api/accounts/check/v4-2023-04-27")return new Response(JSON.stringify({
        selected_account_id:"selected-business-workspace",accounts:{
          personal:{account:{plan_type:"plus"}},
          "selected-business-workspace":{account:{plan_type:"business"}}
        }
      }),{status:200,headers:{"content-type":"application/json"}});
      if(url.startsWith("/backend-api/accounts/selected-business-workspace/users?"))
        return new Response(JSON.stringify({items:[
          {id:"somebody-else",seat_type:"standard"},
          {id:"test-current-user",email:"current@example.invalid",seat_type:"premium"}
        ],total:2,limit:25}),{status:200,headers:{"content-type":"application/json"}});
      return originalFetch(url,options);
    };
    const listener=__testRuntimeListeners.find((listener)=>listener(
      {type:"AIH_PRO_ACCOUNT_PLAN_READ"},{},(value)=>{
        window.fetch=originalFetch;resolve(value);
      })===true);
    if(!listener){window.fetch=originalFetch;resolve({ok:false,reason:"listener-missing"})}
  })`);
  assert.equal(seatRead?.ok,true,"Business seat should be readable from the current member");
  assert.equal(seatRead?.plan,"business-premium");
  assert.equal(seatRead?.source,"chatgpt-member-seat");
  assert.doesNotMatch(JSON.stringify(seatRead),/SECRET_|current@example|test-current-user|selected-business-workspace/,
    "seat response must not leak member IDs or login secrets");

  // Simulate the user's real-world response: legacy "default" maps to
  // Standard with a visible compatibility indicator, never official certainty.
  const unknownSeatRead = await evaluate(`new Promise((resolve)=>{
    const originalFetch=window.fetch;
    window.fetch=async(url,options)=>{
      if(url==="/api/auth/session")return new Response(JSON.stringify({
        user:{id:"SECRET-MEMBER-ID",email:"private@fixture.invalid"},
        account:{id:"test-business-workspace"}
      }),{status:200,headers:{"content-type":"application/json"}});
      if(url==="/backend-api/accounts/check/v4-2023-04-27")return new Response(JSON.stringify({
        accounts:{"test-business-workspace":{account:{plan_type:"business"}}}
      }),{status:200,headers:{"content-type":"application/json"}});
      if(url.startsWith("/backend-api/accounts/test-business-workspace/users?"))
        return new Response(JSON.stringify({items:[
          {id:"SECRET-MEMBER-ID",seat_type:"default",email:"private@fixture.invalid"}
        ]}),{status:200,headers:{"content-type":"application/json"}});
      return originalFetch(url,options);
    };
    const listener=__testRuntimeListeners.find((listener)=>listener(
      {type:"AIH_PRO_ACCOUNT_PLAN_READ"},{},(value)=>{
        window.fetch=originalFetch;resolve(value);
      })===true);
    if(!listener){window.fetch=originalFetch;resolve({ok:false,reason:"listener-missing"})}
  })`);
  assert.equal(unknownSeatRead?.plan,"business-standard");
  assert.equal(unknownSeatRead?.precise,false,
    "Legacy default alias must be marked approximate");
  assert.equal(unknownSeatRead?.seatMapping,"legacy-default-as-standard");
  assert.equal(unknownSeatRead?.seatTypeCode,"default");
  assert.equal(unknownSeatRead?.seatField,"seat_type");
  assert.equal(unknownSeatRead?.seatMatchedBy,"user-id");
  assert.doesNotMatch(JSON.stringify(unknownSeatRead),/SECRET-MEMBER-ID|private@fixture|test-business-workspace/);
  await waitFor(`__testTimingDebugMessages.some((entry)=>
    entry.stage==="pro-account-plan-read"&&entry.accountPlan==="business-standard"
      &&entry.seatTypeCode==="default"&&entry.seatMapping==="legacy-default-as-standard")`);
  const safeSeatLog = await evaluate(`__testTimingDebugMessages.find((entry)=>
    entry.stage==="pro-account-plan-read"&&entry.seatTypeCode==="default")`);
  assert.equal(safeSeatLog.seatMatchedBy,"user-id");
  assert.equal(safeSeatLog.accountPlan,"business-standard");
  assert.equal(safeSeatLog.seatMapping,"legacy-default-as-standard");
  assert.doesNotMatch(JSON.stringify(safeSeatLog),/SECRET|private@|accessToken|test-business-workspace/,
    "diagnostics must never contain a raw member or authenticated session");

  // Local Pro reset is isolated from message history and preserves the old
  // request-ID ledger across navigation/refresh.
  const beforeProReset = await evaluate(`({
    total:__testMemory.aiInputHistoryProUsage?.models?.["gpt-6-pro"]?.total||0,
    requestIds:Object.keys(__testMemory.aiInputHistoryProUsage?.requestIds||{}).length
  })`);
  assert.equal(beforeProReset.total, 1, "初始 Pro 请求必须仍只计一次");
  assert.equal(beforeProReset.requestIds, 1);
  const proReset = await evaluate(`new Promise((resolve)=>chrome.runtime.sendMessage({type:"AIH_PRO_USAGE_RESET"},resolve))`);
  assert.equal(proReset?.ok,true,"本地重置应完成");
  const afterProReset = await evaluate(`({
    models:__testMemory.aiInputHistoryProUsage?.models,
    ledger:Object.keys(__testMemory.aiInputHistoryProUsage?.requestIds||{}).length,
    resetAt:__testMemory.aiInputHistoryProUsage?.monthResetAt,
    month:AIInputHistory.conversationStatsModel.periodKeys(Date.now()).month
  })`);
  assert.equal(afterProReset.models["gpt-6-pro"].months[afterProReset.month],0,"重置后每日/周/月计数应归零");
  assert.equal(afterProReset.models["gpt-6-pro"].total,1,"本月清零后累计历史不可消失");
  assert.equal(afterProReset.ledger,1,"必须继续保留旧请求去重索引");
  assert.ok(Number.isFinite(afterProReset.resetAt));
  assert.ok(await evaluate(`__testMemory.aiInputHistoryState.entries.length>0`),"重置 Pro 统计不应清空普通输入历史");

  // Two independent toggles: Pro-only must count without rendering a timer,
  // timing-only must render a timer without incrementing Pro count.
  await evaluate(`new Promise((resolve)=>{
    const next={...__testMemory.aiInputHistorySettings,trackRequestTime:false,trackProUsage:true,proPlan:'pro-100'};
    chrome.storage.local.set({aiInputHistorySettings:next},resolve);
  })`);
  await evaluate(`(()=>{
    let model=document.querySelector('#aih-pro-picker-fixture');
    if(!model){model=document.createElement('button');model.id='aih-pro-picker-fixture';
      model.setAttribute('data-testid','model-switcher-dropdown-button');
      document.querySelector('.composer-wrap').appendChild(model);}
    // Regression: the real bottom-composer Pro control can have NO known
    // class, aria-label or model data-testid. It must still count.
    model.removeAttribute('data-testid');
    model.classList.remove('__composer-pill');
    model.type='button';
    model.textContent='Pro';
    const wrap=document.querySelector('.composer-wrap');
    // Production regression: the editor is inside <form>, but the active
    // Pro mode chip is a sibling in the same composer shell/footer.
    const input=wrap.querySelector('.composer');
    const form=document.createElement('form');
    form.id='aih-composer-form-fixture';
    form.addEventListener('submit',(event)=>event.preventDefault());
    input.before(form);
    form.appendChild(input);
    wrap.appendChild(model);
    const upsell=document.createElement('button');
    upsell.textContent='Upgrade to Pro plan';upsell.id='aih-pro-upsell-fixture';
    document.querySelector('.top').appendChild(upsell);
    return true
  })()`);
  assert.equal(await evaluate(`AIInputHistory.proUsageModel.detect()?.id`), 'pro',
    "The bare Pro button beside the composer must be detected without known selector classes");
  assert.equal(await evaluate(`AIInputHistory.proUsageModel.detect()?.evidence`),
    'composer-pro-control', "must use composer-local fallback rather than the upgrade CTA");
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(49)'`);
  // A model menu may expose a selected option which must not hijack
  // the badge away from the live composer model pill.
  assert.equal(await evaluate(`(()=>{
    const menu=document.createElement('div');menu.id='aih-pro-unrelated-menu';
    menu.setAttribute('role','menu');
    menu.innerHTML='<div role="menuitemradio" data-testid="model-picker-option" aria-checked="true">GPT-5.6 Pro</div>';
    document.body.appendChild(menu);
    const selected=AIInputHistory.proUsageModel.detect();
    const match=selected?.id==='pro' && selected?.element?.id==='aih-pro-picker-fixture';
    menu.remove();
    return match;
  })()`),true,'An open model menu must not replace the actual composer selection');
  // Simulate the real Pro button: a flex label + native SVG chevron.
  // The number must be INSIDE the native button, never clipped by its
  // toolbar, and must not add a separate hover/click target.
  await evaluate(`(()=>{
    const model=document.querySelector('#aih-pro-picker-fixture');
    const shell=document.createElement('div');
    shell.id='aih-pro-toolbar-clip';
    shell.style.cssText='display:flex;align-items:center;overflow:hidden;width:max-content;height:36px;position:relative';
    model.parentElement.insertBefore(shell,model);
    shell.appendChild(model);
    const label=document.createElement('span');label.textContent=model.textContent;
    const arrow=document.createElementNS('http://www.w3.org/2000/svg','svg');
    arrow.setAttribute('width','14');arrow.setAttribute('height','14');
    arrow.setAttribute('viewBox','0 0 14 14');arrow.setAttribute('aria-hidden','true');
    arrow.innerHTML='<path d="m2 5 5 5 5-5" stroke="currentColor" fill="none"/>';
    model.replaceChildren(label,arrow);
    model.style.cssText='display:flex;align-items:center;gap:6px;height:30px;padding:0 5px';
    return true
  })()`);
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(49)'`);
  await sleep(120); // Let MutationObserver reposition after React-style toolbar restructuring.
  const clippedProGeometry = await evaluate(`(()=>{
    const badge=document.querySelector('[data-aih-pro-remaining]');
    const model=document.querySelector('#aih-pro-picker-fixture');
    if(!badge||!model)return {valid:false,reason:'missing'};
    const b=badge.getBoundingClientRect(),m=AIInputHistory.proBadgeModel.proLabelRect(document,model);
    const button=model.getBoundingClientRect(),arrow=model.querySelector('svg').getBoundingClientRect();
    const hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
    return {valid:b.left>=m.right+1 && b.right<arrow.left && b.left>=button.left
      && b.right<=button.right && b.top>=button.top && b.bottom<=button.bottom
      && hit?.closest('#aih-pro-picker-fixture')===model,
      badge:b.toJSON(),label:{right:m.right,top:m.top,bottom:m.bottom},button:button.toJSON(),
      arrow:arrow.toJSON(),hit:hit?.tagName,hitId:hit?.id,hitClass:hit?.className?.baseVal||hit?.className,
      gap:getComputedStyle(model).columnGap};
  })()`);
  assert.equal(clippedProGeometry.valid,true,
    'Remaining count must be INSIDE the real Pro button: '+JSON.stringify(clippedProGeometry));
  // React may unmount and recreate the Pro model pill on model selection.
  await evaluate(`(()=>{
    const old=document.querySelector('#aih-pro-picker-fixture');
    const fresh=old.cloneNode(true);
    old.replaceWith(fresh);
    return true;
  })()`);
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(49)'
    && AIInputHistory.proUsageModel.detect()?.element===document.querySelector('#aih-pro-picker-fixture')`);
  assert.equal(await evaluate(`(()=>{
    const badge=document.querySelector('[data-aih-pro-remaining]');
    const model=document.querySelector('#aih-pro-picker-fixture');
    const b=badge.getBoundingClientRect(),m=AIInputHistory.proBadgeModel.proLabelRect(document,model);
    const button=model.getBoundingClientRect(),arrow=model.querySelector('svg').getBoundingClientRect();
    const hit=document.elementFromPoint(b.left+b.width/2,b.top+b.height/2);
    return b.left>=m.right+1 && b.right<arrow.left && b.left>=button.left
      && b.right<=button.right && b.top>=button.top && b.bottom<=button.bottom
      && hit?.closest('#aih-pro-picker-fixture')===model;
  })()`),true,'Badge must remain inside the button after a React model-picker remount');
  await evaluate(`(()=>{document.querySelector('#aih-pro-picker-fixture span').textContent='Instant';return true})()`);
  await waitFor(`!document.querySelector('[data-aih-pro-remaining]')`);
  await evaluate(`(()=>{document.querySelector('#aih-pro-picker-fixture span').textContent='Pro';return true})()`);
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(49)'`);
  await evaluate(`(()=>{
    const composer=document.querySelector('.composer');
    composer.value='Pro 计数独立测试';composer.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.send').click();return true
  })()`);
  await waitFor(`__testMemory.aiInputHistoryProUsage?.models?.pro?.total===1`);
  assert.equal(await evaluate(`__testMemory.aiInputHistoryProUsage.models['gpt-6-pro'].total`),1,
    "The Pro-only request must not be silently classified as GPT-6 Pro");
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(48)'`);
  assert.equal(await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`),false,
    "只开启 Pro 次数时不应显示计时器");
  await evaluate(`([...document.querySelectorAll("button")].find((b)=>b.textContent==="模拟回复完成")?.click(),true)`);
  // Simulate a React composer remount which drops send-detector.emit()
  // while the page truly begins generating. The timer's busy observation
  // must count this Pro generation using the SAME request ID ledger.
  const generationFallback = await evaluate(`(()=>{
    const proto=AIInputHistory.SendDetector.prototype;
    window.__aihOriginalSendEmit=proto.emit;
    proto.emit=function(){};
    const composer=document.querySelector('.composer');
    composer.value='Pro generation fallback';
    composer.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.send').disabled=false;
    document.querySelector('.send').click();
    return true
  })()`);
  assert.equal(generationFallback,true);
  await waitFor(`__testMemory.aiInputHistoryProUsage?.models?.pro?.total===2`);
  const fallbackState = await evaluate(`(()=>{
    AIInputHistory.SendDetector.prototype.emit=window.__aihOriginalSendEmit;
    delete window.__aihOriginalSendEmit;
    return {
      count:__testMemory.aiInputHistoryProUsage.models.pro.total,
      fallbackEntry:__testMemory.aiInputHistoryState.entries.find(
        (entry)=>entry.text==="Pro generation fallback")
    };
  })()`);
  assert.equal(fallbackState.count,2,
    "A real generation must count even if no confirmed send history is stored");
  assert.equal(fallbackState.fallbackEntry,undefined,
    "This test must truly skip the confirmed send record");
  await waitFor(`document.querySelector('[data-aih-pro-remaining]')?.textContent === '(47)'`);
  await evaluate(`([...document.querySelectorAll("button")].find((b)=>b.textContent==="模拟回复完成")?.click(),true)`);

  await evaluate(`new Promise((resolve)=>{
    const next={...__testMemory.aiInputHistorySettings,trackRequestTime:true,trackProUsage:false};
    chrome.storage.local.set({aiInputHistorySettings:next},resolve);
  })`);
  await waitFor(`!document.querySelector('[data-aih-pro-remaining]')`);
  await evaluate(`(()=>{
    const composer=document.querySelector('.composer');
    composer.value='计时独立测试';composer.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.send').click();return true
  })()`);
  await waitFor(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`);
  assert.equal(await evaluate(`__testMemory.aiInputHistoryProUsage?.models?.pro?.total`),2,
    "只打开计时且仍选择 Pro 模型时，不可增加 Pro 模型次数");

  // Timing must survive ChatGPT replacing a local-chatgpt provisional URL
  // with the server UUID while the response is still generating.
  await evaluate(`(()=>{
    document.querySelector('[data-testid="stop-button"]')?.remove();
    history.pushState({}, "", "/c/local-chatgpt:aaaabbbb-1111-2222-3333-444455556666");
    document.querySelector(".thread").innerHTML="";
    document.querySelector(".composer").value="临时会话地址变更测试";
    document.querySelector(".composer").dispatchEvent(new Event("input",{bubbles:true}));
    document.querySelector(".send").click();
    return true
  })()`);
  await waitFor(`__testMemory.aiInputHistoryActiveTimingByUrl?.["127.0.0.1::conversation:local-chatgpt:aaaabbbb-1111-2222-3333-444455556666"]?.requestId`);
  const tempRequest = await evaluate(`__testMemory.aiInputHistoryActiveTimingByUrl["127.0.0.1::conversation:local-chatgpt:aaaabbbb-1111-2222-3333-444455556666"].requestId`);
  await evaluate(`(history.pushState({}, "", "/c/6acf1bda-6bc4-83ee-9b4e-6144bb94d490"),true)`);
  await waitFor(`__testMemory.aiInputHistoryActiveTimingByUrl?.["127.0.0.1::conversation:6acf1bda-6bc4-83ee-9b4e-6144bb94d490"]?.requestId===${JSON.stringify(tempRequest)}`);
  const canonicalState = await evaluate(`(()=>{
    const root=document.querySelector("[data-ai-input-history='root']").shadowRoot;
    return {
      active:root.querySelector(".launcher").classList.contains("timing-active"),
      counter:root.querySelector(".request-clock").textContent,
      old:__testMemory.aiInputHistoryActiveTimingByUrl["127.0.0.1::conversation:local-chatgpt:aaaabbbb-1111-2222-3333-444455556666"],
      entry:__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="临时会话地址变更测试")?.requestTiming
    }
  })()`);
  assert.equal(canonicalState.active,true,"会话临时地址转正式 UUID 后计时必须保持可见");
  assert.match(canonicalState.counter,/^\d+s$/);
  assert.equal(canonicalState.old,undefined,"旧临时会话状态应迁移到正式会话");
  assert.notEqual(canonicalState.entry?.status,"cancelled","路由变化不得取消仍在回复的请求");
  await evaluate(`([...document.querySelectorAll("button")].find((b)=>b.textContent==="模拟回复完成")?.click(),true)`);
  await waitFor(`__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="临时会话地址变更测试")?.requestTiming?.status==="completed"`);
  assert.equal(await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`),false);

  console.log(`浏览器计时/Queue 验收通过：文本请求 ${Math.round(finalState.timing.durationMs)}ms；Queue 可右键禁用直发并恢复，悬浮计时右键可停止`);
} finally {
  socket.close();
  const exited = new Promise((resolve) => browser.once("exit", resolve));
  browser.kill();
  await Promise.race([exited, sleep(2_000)]);
  await new Promise((resolve) => server.close(resolve));
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 125 });
  } catch (error) {
    console.warn(`浏览器临时目录稍后由系统清理：${error.code || error.message}`);
  }
}
