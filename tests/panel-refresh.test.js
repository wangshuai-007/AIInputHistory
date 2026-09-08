const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function setup() {
  const context = { globalThis: {}, console, setTimeout, clearTimeout };
  for (const name of ['i18n', 'history-panel-utils', 'history-panel']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, `../src/${name}.js`), 'utf8'), context);
  }
  const requests = [];
  const panel = Object.create(context.globalThis.AIInputHistory.HistoryPanel.prototype);
  Object.assign(panel, {
    refreshRevision: 0, items: [], selectedIndex: 0, search: { value: '' }, selectedSite: 'a',
    store: { getHistory: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) },
    shadow: { querySelector: () => ({ classList: { add() {} } }) },
    render() { this.renders = (this.renders || 0) + 1; },
    reportError(error) { this.error = error; }
  });
  return { panel, requests, context };
}

test('较慢的旧搜索响应不会覆盖新的结果', async () => {
  const { panel, requests } = setup();
  const first = panel.refresh();
  panel.search.value = 'new';
  const second = panel.refresh();
  requests[1].resolve([{ id: 'new' }]);
  await second;
  requests[0].resolve([{ id: 'old' }]);
  await first;
  assert.equal(panel.items[0].id, 'new');
  assert.equal(panel.renders, 1);
});

test('旧请求失败不会覆盖最新成功结果的状态', async () => {
  const { panel, requests } = setup();
  const first = panel.refresh();
  const second = panel.refresh();
  requests[1].resolve([{ id: 'new' }]);
  await second;
  requests[0].reject(new Error('旧错误'));
  await first;
  assert.equal(panel.error, undefined);
});

test('跨窗口插入新消息后保留按 ID 选中的消息', async () => {
  const { panel, requests } = setup();
  panel.items = [{ id: 'chosen' }];
  panel.filterKey = JSON.stringify(['', undefined, 'a', undefined]);
  const task = panel.refresh();
  requests[0].resolve([{ id: 'new' }, { id: 'chosen' }]);
  await task;
  assert.equal(panel.selectedIndex, 1);
});

test('切换搜索后选择重置为新结果第一条', async () => {
  const { panel, requests } = setup();
  panel.items = [{ id: 'chosen' }];
  panel.filterKey = 'old-filter';
  const task = panel.refresh();
  requests[0].resolve([{ id: 'new' }, { id: 'chosen' }]);
  await task;
  assert.equal(panel.selectedIndex, 0);
});

test('上下键更新选择样式，不重建整份列表', () => {
  const { panel } = setup();
  let selected = -1;
  panel.items = [{ id: 'a' }, { id: 'b' }];
  panel.list = {
    querySelectorAll: () => [0, 1].map((index) => ({
      classList: { toggle(_, enabled) { if (enabled) selected = index; } }, setAttribute() {}
    })),
    querySelector: () => ({ scrollIntoView() {} })
  };
  panel.moveSelection(1);
  assert.equal(selected, 1);
  assert.equal(panel.renders, undefined);
});

test('设置页版本由 manifest 读取而非硬编码', () => {
  const html = fs.readFileSync(path.join(__dirname, '../popup/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../popup/popup.js'), 'utf8');
  assert.doesNotMatch(html, /<span>v\d/);
  assert.match(js, /getManifest\(\).version/);
  assert.match(js, /store.patchSettings\(patch\)/);
});
