const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

test('网站图标不请求第三方，不携带 Cookie 或来源地址', async () => {
  const requests = [];
  const context = {
    globalThis: {}, URL, AbortSignal, console,
    location: { origin: 'https://chat.example', href: 'https://chat.example/conversation/private' },
    document: { querySelectorAll: () => [{ href: 'https://cdn.example/icon.png' }, { href: 'https://chat.example/icon.png' }] },
    fetch: async (url, options) => { requests.push({ url, options }); return { ok: false }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/site-icon.js'), 'utf8'), context);
  await context.globalThis.AIInputHistory.captureSiteIcon({}, 'chat.example');
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(new URL(url).origin, 'https://chat.example');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
  }
});
