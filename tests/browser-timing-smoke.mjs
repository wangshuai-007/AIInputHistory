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
const targetUrl = `http://127.0.0.1:${webPort}/store-assets/screenshot-fixture.html?lang=zh-CN&timing=1&notify=1`;
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
  const caretRules = await evaluate(`(async()=>{const c=document.querySelector(".composer"); c.style.width="120px"; c.value="这是一段没有换行符但是长度足够触发编辑框自动折行的测试文字用于验证视觉行判断"; c.setSelectionRange(18,18); const wrapped={up:AIInputHistory.InputAdapter.canMoveVertically(c,"up"),down:AIInputHistory.InputAdapter.canMoveVertically(c,"down")}; c.style.width="100%"; c.value="第一行\\n第二行\\n第三行"; c.setSelectionRange(6,6); const middle={up:AIInputHistory.InputAdapter.canMoveVertically(c,"up"),down:AIInputHistory.InputAdapter.canMoveVertically(c,"down")}; const rich=document.createElement("div"); rich.contentEditable="true"; rich.setAttribute("role","textbox"); rich.style.cssText="position:fixed;left:-10000px;top:0;width:120px;white-space:pre-wrap"; rich.textContent="第一行内容\\n第二行内容\\n第三行内容"; document.body.appendChild(rich); rich.focus(); const text=rich.firstChild; const selection=getSelection(); const range=document.createRange(); range.setStart(text,8); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); const richMiddle={up:AIInputHistory.InputAdapter.canMoveVertically(rich,"up"),down:AIInputHistory.InputAdapter.canMoveVertically(rich,"down")}; rich.textContent="继续追问"; rich.focus(); const singleText=rich.firstChild; const singleRange=document.createRange(); singleRange.setStart(singleText,singleText.textContent.length); singleRange.collapse(true); selection.removeAllRanges(); selection.addRange(singleRange); const richSingleUp=AIInputHistory.InputAdapter.canMoveVertically(rich,"up"); singleRange.setStart(singleText,0); singleRange.collapse(true); selection.removeAllRanges(); selection.addRange(singleRange); const richSingleDown=AIInputHistory.InputAdapter.canMoveVertically(rich,"down"); rich.remove(); c.focus(); c.setSelectionRange(6,6); let leaked=0; document.addEventListener("keydown",(event)=>{if(event.key==="ArrowUp")leaked+=1},{capture:true,once:true}); c.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true})); await new Promise((resolve)=>setTimeout(resolve,80)); const middleText=c.value; c.setSelectionRange(0,0); const firstUp=AIInputHistory.InputAdapter.canMoveVertically(c,"up"); c.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowUp",bubbles:true,cancelable:true})); await new Promise((resolve)=>setTimeout(resolve,80)); return {wrapped,middle,richMiddle,richSingleUp,richSingleDown,firstUp,leaked,middleText,historyText:c.value}})()`);
  assert.deepEqual(caretRules.wrapped, { up: true, down: true }, "textarea 自动折行也应按视觉行判断上下边界");
  assert.deepEqual(caretRules.middle, { up: true, down: true }, "多行输入中间行应保留上下行移动");
  assert.deepEqual(caretRules.richMiddle, { up: true, down: true }, "contenteditable/ProseMirror 类输入框中间行也应保留上下行移动");
  assert.equal(caretRules.richSingleUp, false, "单行 contenteditable 行尾 ArrowUp 不应误判成上一视觉行");
  assert.equal(caretRules.richSingleDown, false, "单行 contenteditable 行首 ArrowDown 不应误判成下一视觉行");
  assert.equal(caretRules.firstUp, false, "第一行不能再向上移动时才允许切历史");
  assert.equal(caretRules.middleText, "第一行\n第二行\n第三行", "中间行 ArrowUp 不得切换历史");
  assert.equal(caretRules.leaked, 0, "方向键不能继续传播给页面自己的快捷键处理器");
  assert.notEqual(caretRules.historyText, caretRules.middleText, "第一行 ArrowUp 应切换到历史记录");
  await evaluate(`(()=>{const c=document.querySelector(".composer"); c.value="计时验收"; c.dispatchEvent(new Event("input",{bubbles:true})); return true})()`);
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot; if(root.querySelector(".panel").classList.contains("hidden")) root.querySelector(".launcher").click(); document.querySelector(".send").click(); return true})()`);
  await sleep(1200);
  const running = await evaluate(`(()=>{const l=document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher"); return {active:l.classList.contains("timing-active"),clock:l.querySelector(".request-clock").textContent}})()`);
  assert.equal(running.active, true, `发送后悬浮按钮应进入计时状态；页面状态=${JSON.stringify(await evaluate(`({settings:__testMemory.aiInputHistorySettings,entries:__testMemory.aiInputHistoryState.entries.slice(0,5),profile:AIInputHistory.SiteProfiles.forSite(location.hostname)?.id||null,sample:AIInputHistory.requestTimingModel.sampleChatGPT()})`))}；浏览器事件=${JSON.stringify(browserEvents.slice(-8))}`);
  assert.match(running.clock, /^\d+s$/, "悬浮按钮应显示当前请求秒数");
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
  const fastReply = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot; const entry=__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="hello"); return {timing:entry?.requestTiming||null,launcherActive:root.querySelector(".launcher").classList.contains("timing-active"),notifications:__testNotificationMessages.map((item)=>item.event?.promptText),sample:AIInputHistory.requestTimingModel.sampleChatGPT(),sessions:JSON.parse(localStorage.getItem("aih-fixture-timings")||"{}")}})()`);
  assert.equal(fastReply.timing?.status, "completed", `超快回复即使未采到 stop/send/action 信号也应完成计时；状态=${JSON.stringify(fastReply)}`);
  assert.equal(fastReply.launcherActive, false, "超快回复稳定后应结束计时");
  assert.deepEqual(fastReply.notifications, ["计时验收", "hello"], "超快回复完成后也必须发出完成通知事件");
  await evaluate(`(document.querySelector(".send").disabled=false,true)`);

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
  const idleDirect = await evaluate(`({queued:Object.values(__testMemory.aiInputHistoryPromptQueues||{}).flat().some((item)=>item.text==="空闲直接发送"),composer:document.querySelector('.composer').value})`);
  assert.equal(idleDirect.queued, false, "当前没有等待 GPT 回复时，物理点击发送不得进入 Queue");
  assert.equal(idleDirect.composer, "", "空闲状态应直接由 ChatGPT 消费输入内容");
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await sleep(700);

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
  assert.deepEqual(launcherMenu.labels, ["隐藏悬浮按钮", "停止计时"], "右键菜单应同时提供隐藏和停止计时");
  assert.equal(launcherMenu.stopDisabled, false, "正在计时时停止计时菜单必须可用");
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot;root.querySelector('[data-launcher-action="stop"]').click();return true})()`);
  await waitFor(`!document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`);
  const stoppedTiming = await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot;const entry=__testMemory.aiInputHistoryState.entries.find((item)=>item.text==="右键停止计时测试");return {status:entry?.requestTiming?.status||null,launcherHidden:root.querySelector('.launcher').classList.contains('hidden')}})()`);
  assert.equal(stoppedTiming.status, "cancelled", "停止计时应保存 cancelled 状态");
  assert.equal(stoppedTiming.launcherHidden, false, "停止计时不能同时隐藏悬浮按钮");

  console.log(`浏览器计时/Queue 验收通过：文本请求 ${Math.round(finalState.timing.durationMs)}ms；Queue 可恢复异常发送，悬浮计时右键可停止`);
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
