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
const targetUrl = `http://127.0.0.1:${webPort}/store-assets/screenshot-fixture.html?lang=zh-CN&timing=1`;
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
  await evaluate(`(()=>{const root=document.querySelector("[data-ai-input-history='root']").shadowRoot; if(root.querySelector(".panel").classList.contains("hidden")) root.querySelector(".launcher").click(); const c=document.querySelector(".composer"); c.value="计时验收"; c.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector(".send").click(); return true})()`);
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

  const historyCount = await evaluate(`__testMemory.aiInputHistoryState.entries.length`);
  await evaluate(`(()=>{const c=document.querySelector(".composer"); c.value=""; c.dispatchEvent(new Event("input",{bubbles:true})); document.querySelector(".send").click(); return true})()`);
  await sleep(800);
  const imageOnly = await evaluate(`(()=>{const l=document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher"); return {active:l.classList.contains("timing-active"),count:__testMemory.aiInputHistoryState.entries.length}})()`);
  assert.equal(imageOnly.active, true, "纯图片/附件、无文本时点击发送按钮也应开始计时");
  assert.equal(imageOnly.count, historyCount, "无文本请求不应伪造输入历史记录");
  await evaluate(`([...document.querySelectorAll("button")].find((button)=>button.textContent==="模拟回复完成")?.click(),true)`);
  await sleep(1200);
  assert.equal(await evaluate(`document.querySelector("[data-ai-input-history='root']").shadowRoot.querySelector(".launcher").classList.contains("timing-active")`), false, "纯图片/附件回复完成后应恢复历史图标");
  console.log(`浏览器计时验收通过：文本请求 ${Math.round(finalState.timing.durationMs)}ms；纯图片/附件请求也可独立计时`);
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
