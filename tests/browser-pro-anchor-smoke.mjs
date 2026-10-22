import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const browserPath = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find(fs.existsSync);
assert.ok(browserPath, "Chrome or Edge is required");
const server = http.createServer((req, res) => {
  const file = path.resolve(root, "." + new URL(req.url, "http://localhost").pathname);
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8" });
    res.end(data);
  });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "aih-pro-anchor-"));
const browser = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number(fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]); } catch {}
    if (port) break;
    await sleep(100);
  }
  assert.ok(port, "DevTools did not start");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const msg = JSON.parse(event.data), item = pending.get(msg.id);
    if (!item) return;
    pending.delete(msg.id); clearTimeout(item.timeout);
    msg.error ? item.reject(new Error(msg.error.message)) : item.resolve(msg.result);
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout: " + method)); }, 10000);
      pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let i = 0; i < 40; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error("State timeout: " + expression);
  }
  await send("Runtime.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1260, height: 500, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/tests/pro-anchor-fixture.html` });
  await waitFor("Boolean(window.testBadge)");
  await waitFor("Boolean(document.querySelector('[data-aih-pro-remaining]'))");
  assert.equal(await evaluate("document.querySelector('[data-aih-pro-remaining]').textContent"), "(14)");
  const metrics = await evaluate(`(() => {
    const badge=document.querySelector('[data-aih-pro-remaining]');
    const p=document.querySelector('#composer-pro-label').getBoundingClientRect();
    const b=badge.getBoundingClientRect();
    const microphone=document.querySelector('#microphone').getBoundingClientRect();
    const button=document.querySelector('#composer-pro').getBoundingClientRect();
    const chevron=document.querySelector('#composer-pro svg').getBoundingClientRect();
    return { label:{left:p.left,right:p.right,top:p.top,bottom:p.bottom},
      badge:{left:b.left,right:b.right,top:b.top,bottom:b.bottom},
      button:{left:button.left,right:button.right,top:button.top,bottom:button.bottom},
      chevron:{left:chevron.left,right:chevron.right,top:chevron.top,bottom:chevron.bottom},
      micLeft:microphone.left,
      title:badge.title, focusable:badge.hasAttribute('tabindex'),
      pointer:getComputedStyle(badge).pointerEvents,
      target:testBadge.target?.id, labelText:document.querySelector('#composer-pro-label').textContent };
  })()`);
  assert.equal(metrics.target, "composer-pro", "Must target the composer's Pro, not the page-header model selector");
  assert.ok(metrics.badge.left >= metrics.label.right + 1,
    "Count must follow the Pro text INSIDE the model button");
  assert.ok(metrics.badge.right < metrics.chevron.left,
    "Count must be between the Pro text and the chevron");
  assert.ok(metrics.badge.left >= metrics.button.left && metrics.badge.right <= metrics.button.right
    && metrics.badge.top >= metrics.button.top && metrics.badge.bottom <= metrics.button.bottom,
    "The entire count must fit INSIDE the Pro button: " + JSON.stringify(metrics));
  assert.equal(metrics.title, "", "No tooltip on hover");
  assert.equal(metrics.focusable, false, "No extra focusable hint");
  assert.equal(metrics.pointer, "none", "Clicking the number must still click the model button");
  assert.ok(metrics.badge.right < metrics.micLeft, "Must not cover the microphone");
  const currentGap = await evaluate("parseFloat(getComputedStyle(document.querySelector('#composer-pro')).columnGap)");
  assert.ok(currentGap > 10, "The model button should reserve room for the count INSIDE the chevron");
  assert.equal(await evaluate("document.elementFromPoint((metricsDummy=>metricsDummy.left + metricsDummy.width/2)(document.querySelector('[data-aih-pro-remaining]').getBoundingClientRect()), document.querySelector('[data-aih-pro-remaining]').getBoundingClientRect().top+6)?.closest('#composer-pro')?.id"), "composer-pro",
    "Clicks on the in-button number must reach ChatGPT's original model control");
  assert.equal(metrics.labelText, "Pro", "Do not modify React-owned label text");
  assert.equal(await evaluate(`(() => { const b=document.querySelector('#composer-pro').getBoundingClientRect();
    return document.elementFromPoint(b.left+10,b.top+10)?.closest('#composer-pro')?.id; })()`), "composer-pro", "The model picker remains clickable");
  await evaluate("document.querySelector('#composer-pro').click()");
  assert.equal(await evaluate("window.modelClicks"), 1);
  await evaluate("testBadge.updateUsage(makeUsage(2));");
  await waitFor("document.querySelector('[data-aih-pro-remaining]')?.textContent === '(13)'");
  await evaluate("document.querySelector('#composer-pro-label').firstChild.nodeValue='Instant';");
  await waitFor("!document.querySelector('[data-aih-pro-remaining]')");
  assert.equal(await evaluate("document.querySelector('#composer-pro').style.columnGap"), "",
    "Switching away from Pro must restore native model button spacing");
  assert.equal(await evaluate("document.querySelector('#composer-pro').hasAttribute('data-aih-pro-gap')"), false,
    "No sizing metadata remains on Instant");
  await evaluate("document.querySelector('#composer-pro-label').firstChild.nodeValue='Pro';");
  await waitFor("document.querySelector('[data-aih-pro-remaining]')?.textContent === '(13)'");
  await evaluate(`(() => { const node=document.querySelector('#composer-pro'); const fresh=node.cloneNode(true); node.replaceWith(fresh); })()`);
  await waitFor("testBadge.target === document.querySelector('#composer-pro')");
  assert.equal(await evaluate("document.querySelectorAll('[data-aih-pro-remaining]').length"), 1);
  assert.equal(await evaluate("parseFloat(getComputedStyle(document.querySelector('#composer-pro')).columnGap)"),
    currentGap, "React cloning the styled button must not repeatedly expand the gap");
  // ChatGPT frequently portals or deeply nests the selected model control:
  // it can be visually adjacent to the editor without sharing DOM ancestors.
  await evaluate(`(() => {
    const button=document.querySelector('#composer-pro');
    const rect=button.getBoundingClientRect();
    const portal=document.createElement('div');
    portal.id='model-portal';
    portal.style.cssText='position:fixed;left:'+rect.left+'px;top:'+rect.top+'px;width:'+rect.width+'px;height:'+rect.height+'px;z-index:9000;';
    document.body.appendChild(portal);
    portal.appendChild(button);
    return true;
  })()`);
  await waitFor("testBadge.target === document.querySelector('#composer-pro') && Boolean(document.querySelector('[data-aih-pro-remaining]'))");
  assert.equal(await evaluate("AIInputHistory.proUsageModel.detect(document,{composerOnly:true})?.element?.id"), "composer-pro",
    "The visually adjacent Pro control must be detectable even if React portals it elsewhere in the DOM");
  await evaluate("document.querySelector('#composer-pro').remove();");
  await waitFor("!document.querySelector('[data-aih-pro-remaining]')");
  assert.equal(await evaluate("document.querySelector('#header-pro').textContent"), "GPT-6 Pro", "An unrelated header still exists; it must not receive a badge");
  await send("Page.reload"); await waitFor("Boolean(window.testBadge)");
  await waitFor("document.querySelector('[data-aih-pro-remaining]')?.textContent === '(14)'");
  for (const width of [390, 768, 1260]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 500, deviceScaleFactor: 1, mobile: false });
    await sleep(120);
    const valid = await evaluate(`(() => { const badge=document.querySelector('[data-aih-pro-remaining]');
      const b=badge.getBoundingClientRect(),p=document.querySelector('#composer-pro-label').getBoundingClientRect();
      const m=document.querySelector('#composer-pro').getBoundingClientRect();
      const a=document.querySelector('#composer-pro svg').getBoundingClientRect();
      return b.left>=p.right+1 && b.right<a.left && b.left>=m.left
        && b.right<=m.right && b.top>=m.top && b.bottom<=m.bottom
        && b.right<document.querySelector('#microphone').getBoundingClientRect().left; })()`);
    assert.equal(valid, true, "The compact counter stays with the composer at width=" + width);
  }
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const revision = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
  const out = path.join(root, "dist", "pro-composer-anchor-" + revision + ".png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));

  // Chrome DevTools defaults to the PAGE world. Content-script globals in an
  // isolated world are invisible there; the DOM diagnostics must still work.
  const source = ["conversation-stats.js", "pro-usage.js", "pro-quota.js", "pro-badge.js"]
    .map(file => fs.readFileSync(path.join(root, "src", file), "utf8"))
    .join("\n");
  const bootstrap = `
    globalThis.chrome = { runtime: { getManifest: () => ({ version: ${JSON.stringify(revision)} }) } };
    document.addEventListener("DOMContentLoaded", () => {
      const ns = globalThis.AIInputHistory;
      const periods = ns.conversationStatsModel.periodKeys(Date.now());
      const stats = { version: 1, models: { pro: {
        total: 1, days: { [periods.day]: 1 },
        weeks: { [periods.week]: 1 }, months: { [periods.month]: 1 }
      } } };
      const badge = new ns.ProModelBadge({ host: "chatgpt.com" });
      badge.updateUsage(stats);
      badge.setSettings({ trackProUsage: true, proPlan: "business-standard" });
      badge.start();
    }, { once: true });
  `;
  await send("Page.addScriptToEvaluateOnNewDocument", {
    worldName: "AIH isolated content test", source: source + "\n" + bootstrap
  });
  await send("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/tests/pro-isolated-context-fixture.html`
  });
  await waitFor(`document.documentElement.getAttribute('data-aih-pro-state') === 'shown'`);
  assert.equal(await evaluate("typeof globalThis.AIInputHistory"), "undefined",
    "The PAGE console must not be expected to access content-script globals");
  assert.equal(await evaluate("document.documentElement.getAttribute('data-aih-pro-version')"), revision,
    "Page-console-safe diagnostics must expose the extension version");
  assert.equal(await evaluate("document.querySelector('[data-aih-pro-remaining]')?.textContent"), "(14)",
    "The chosen Pro control must show its compact count even when the arrow is literal text");
  console.log("PRO_ISOLATED_WORLD_PASS: page global undefined, DOM status shown, version and count available");
  console.log("PRO_ANCHOR_BROWSER_PASS: screenshot-position, header exclusion, count update, text-node model switch, remount, portal, responsive layout, native click");
  console.log("SCREENSHOT=" + out);
} finally {
  socket?.close(); browser.kill(); server.close();
  for (let i=0;i<10;i++) { try { fs.rmSync(profile,{recursive:true,force:true}); break; } catch { await sleep(200); } }
}
