const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function setup() {
  const data = {};
  const env = { URL, chrome: { runtime: {}, storage: { local: {
    get: (key, callback) => callback({ [key]: structuredClone(data[key]) }),
    set: (value, callback) => { Object.assign(data, structuredClone(value)); callback(); }
  } } } };
  env.globalThis = env;
  for (const name of ['history-store', 'i18n', 'history-panel-utils']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../src/${name}.js`), 'utf8'), env);
  }
  return { store: new env.AIInputHistory.HistoryStore(), ns: env.AIInputHistory };
}

test('发送时间与完成元数据关联正确，更新不丢固定状态', async () => {
  const { store } = setup();
  const entry = await store.addEntry('问题', 'send', { fieldKey: 'f', site: 'chatgpt.com', sentAt: 1000, trackRequestTime: true });
  assert.equal(entry.createdAt, 1000);
  assert.equal(entry.requestTiming.status, 'pending');
  await store.setPinned(entry, true);
  await store.updateRequestTiming(entry.id, { status: 'completed', startedAt: 1000, completedAt: 5230 });
  const saved = (await store.getState()).entries[0];
  assert.equal(saved.pinned, true);
  assert.equal(saved.requestTiming.durationMs, 4230);
  assert.equal(saved.requestTiming.completedAt, 5230);
});

test('清空或淘汰记录后完成回调不复活历史', async () => {
  const { store } = setup();
  const entry = await store.addEntry('问题', 'send', { fieldKey: 'f' });
  await store.clearHistory();
  assert.equal(await store.updateRequestTiming(entry.id, { status: 'completed', startedAt: 1, completedAt: 2 }), false);
  assert.equal((await store.getHistory('', false)).length, 0);
});

test('关闭功能保留旧时间记录，不给普通发送伪造耗时', async () => {
  const { store } = setup();
  assert.equal((await store.getSettings()).trackRequestTime, false);
  await store.patchSettings({ trackRequestTime: true });
  assert.equal((await store.getSettings()).trackRequestTime, true);
  const entry = await store.addEntry('普通问题', 'send', { fieldKey: 'f' });
  assert.equal(entry.requestTiming, undefined);
});

test('历史底部显示完成秒数，未完成不显示假的总耗时', () => {
  const { ns } = setup();
  const render = ns.historyPanelUtils.timingMarkup;
  assert.equal(render({ kind: 'send' }), '');
  assert.match(render({ kind: 'send', requestTiming: { status: 'completed', completedAt: Date.now(), durationMs: 12340 } }), /总耗时 12.3 秒/);
  const pending = render({ kind: 'send', requestTiming: { status: 'pending', startedAt: 1 } });
  assert.match(pending, /尚未记录回复完成/);
  assert.doesNotMatch(pending, /总耗时/);
  ns.i18n.setLanguage('en');
  assert.match(render({ kind: 'send', requestTiming: { status: 'cancelled' } }), /Timing stopped/);
});
