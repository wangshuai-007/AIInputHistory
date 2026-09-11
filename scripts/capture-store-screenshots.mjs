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
    const type = file.endsWith(".html") ? "text/html; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "application/octet-stream";
    response.writeHead(200, { "Content-Type": type }); response.end(data);
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const webPort = server.address().port;
const debugPort = await freePort();
const profile = path.join(os.tmpdir(), `aih-store-shots-${process.pid}-${Date.now()}`);
const browser = spawn(chromePath, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });

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
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
  message.error ? reject(new Error(message.error.message)) : resolve(message.result);
});
function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "页面脚本执行失败");
  return result.result.value;
}
async function waitFor(expression) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error(`等待页面状态超时: ${expression}`);
}
async function screenshot(filename) {
  const result = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(root, "store-assets", filename), Buffer.from(result.data, "base64"));
  console.log(`已生成 ${filename}`);
}

async function captureHistory(lang, filename) {
  const url = `http://127.0.0.1:${webPort}/store-assets/screenshot-fixture.html?lang=${encodeURIComponent(lang)}`;
  await send("Page.navigate", { url });
  await waitFor(`location.href.includes("screenshot-fixture.html")`);
  await evaluate(`localStorage.clear()`);
  await send("Page.navigate", { url });
  await waitFor(`Boolean(document.querySelector("[data-ai-input-history='root']")?.shadowRoot?.querySelector(".panel:not(.hidden)"))`);
  await sleep(500);
  await screenshot(filename);
}

const popupMock = `(() => {
  const lang = new URLSearchParams(location.search).get("lang") === "en" ? "en" : "zh-CN";
  const listeners = [];
  const data = {
    aiInputHistorySettings: {
      historyLimit: 100, sendLimit: 10, snapshotSeconds: 60, shortcut: "Ctrl+R", language: lang,
      launcherEnabled: true, trackRequestTime: true, customDomains: [],
      completionNotification: {
        enabled: true, provider: "browser", minDurationSeconds: 20,
        barkUrl: "", serverChanKey: "", pushPlusToken: "", ntfyUrl: "https://ntfy.sh", ntfyTopic: "",
        gotifyUrl: "", gotifyToken: "", dingtalkWebhook: "", feishuWebhook: "", wecomWebhook: "",
        customMethod: "POST", customUrl: "", customHeaders: "{}", customBody: "{\\"title\\":\\"{{title}}\\",\\"message\\":\\"{{message}}\\"}"
      }
    },
    aiInputHistoryState: { entries: [], drafts: {}, positions: {}, siteIcons: {} }
  };
  globalThis.chrome = {
    runtime: { lastError: null, getManifest: () => ({ version: "1.29.2" }), sendMessage: (_message, callback) => callback?.({ ok: true }) },
    permissions: { request: (_request, callback) => callback(true) },
    storage: {
      onChanged: { addListener(listener) { listeners.push(listener); } },
      local: {
        get(key, callback) { callback({ [key]: data[key] }); },
        set(value, callback) { Object.assign(data, value); callback?.(); }
      }
    }
  };
})();`;

async function captureSettings(lang, filename) {
  const injected = await send("Page.addScriptToEvaluateOnNewDocument", { source: popupMock });
  const url = `http://127.0.0.1:${webPort}/popup/index.html?lang=${encodeURIComponent(lang)}`;
  await send("Page.navigate", { url });
  await waitFor(`document.querySelector("#notifyMinDurationSeconds")?.value === "20"`);
  await evaluate(`(() => {
    document.documentElement.style.background = "#e8efea";
    document.body.style.width = "520px";
    document.body.style.margin = "28px auto";
    document.body.style.boxShadow = "0 24px 70px rgba(35,58,42,.18)";
    document.body.style.borderRadius = "18px";
    document.body.style.overflow = "hidden";
    const main = document.querySelector("main"); main.style.padding = "22px";
    ["header", ".privacy-note", ".summary", ".settings", ".domains", "#status", "footer"].forEach((selector) => {
      const node = document.querySelector(selector); if (node) node.style.display = "none";
    });
    const group = document.querySelector(".chatgpt-settings"); group.style.marginTop = "0";
    return true;
  })()`);
  await sleep(250);
  await screenshot(filename);
  await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injected.identifier });
}

try {
  await Promise.all([send("Runtime.enable"), send("Page.enable")]);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await captureHistory("zh-CN", "screenshot-zh-CN-1280x800.png");
  await captureHistory("en", "screenshot-en-1280x800.png");
  await captureSettings("zh-CN", "screenshot-settings-zh-CN-1280x800.png");
  await captureSettings("en", "screenshot-settings-en-1280x800.png");
} finally {
  socket.close();
  browser.kill();
  server.close();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { fs.rmSync(profile, { recursive: true, force: true }); break; }
    catch { await sleep(250); }
  }
}
