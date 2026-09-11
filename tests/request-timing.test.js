const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const env = { globalThis: {}, console, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/request-timing.js'), 'utf8'), env);
  const h = { now: 1000, sample: { path: '/c/one', replies: [], busy: false, errors: [] }, writes: [], ticks: [], activeTimers: 0, sessionState: null };
  h.session = {
    save(state) { h.sessionState = JSON.parse(JSON.stringify(state)); },
    async load() { return h.sessionState ? JSON.parse(JSON.stringify(h.sessionState)) : null; },
    clear() { h.sessionState = null; }
  };
  h.tracker = new env.globalThis.AIInputHistory.RequestTiming({
    store: { async updateRequestTiming(id, data) { h.writes.push({ id, ...data }); } },
    sample: () => h.sample, now: () => h.now, onTick: (time) => h.ticks.push(time), session: h.session,
    interval: () => { h.activeTimers++; return 1; }, clear: () => h.activeTimers--
  });
  h.start = () => { h.tracker.setEnabled(true); return h.tracker.start('chatgpt.com'); };
  h.complete = () => {
    h.sample = { ...h.sample, busy: false, replies: [{ key: 'new', nonempty: true, complete: true }] };
    h.now = 6100; h.tracker.tick(); h.now += 500; h.tracker.tick();
  };
  return h;
}

test('默认关闭，非 ChatGPT 不采样、不创建计时器', () => {
  const h = setup();
  assert.equal(h.tracker.start('chatgpt.com'), null);
  h.tracker.setEnabled(true);
  assert.equal(h.tracker.start('claude.ai'), null);
  assert.equal(h.activeTimers, 0);
});

test('新回复完成后写入总耗时及回复时间，并恢复按钮', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true };
  h.now = 3000; h.tracker.tick();
  h.complete();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].durationMs, 5100);
  assert.equal(h.writes[0].completedAt, 6100);
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.activeTimers, 0);
  assert.equal(h.ticks.at(-1), null);
});

test('旧回复和首字输出不能标为本次回复完成', () => {
  const h = setup();
  h.sample.replies = [{ key: 'old', nonempty: true, complete: true }];
  h.tracker.attach(h.start(), 'entry');
  h.now = 5000; h.tracker.tick();
  assert.equal(h.writes.length, 0);
  h.sample.replies.push({ key: 'new', nonempty: true, complete: false });
  h.now = 10000; h.tracker.tick();
  assert.equal(h.writes.length, 0);
  h.tracker.finish('cancelled');
});

test('完成早于记录落库时，挂接后仍能正确保存', () => {
  const h = setup();
  const request = h.start(); h.complete();
  assert.equal(h.writes.length, 0);
  h.tracker.attach(request, 'later');
  assert.equal(h.writes[0].id, 'later');
});

test('Enter 延迟确认仍使用按键时的发送时间和旧回复基线', () => {
  const h = setup(); h.tracker.setEnabled(true);
  const captured = h.tracker.capture('chatgpt.com');
  h.now = 1900;
  h.tracker.attach(h.tracker.start('chatgpt.com', captured), 'entry');
  h.complete();
  assert.equal(h.writes[0].startedAt, 1000);
});

test('关闭设置、切换对话、超时和新错误都不虚构回复耗时', () => {
  for (const action of ['disable', 'navigate', 'timeout', 'error']) {
    const h = setup(); h.tracker.attach(h.start(), 'entry');
    if (action === 'disable') h.tracker.setEnabled(false);
    if (action === 'navigate') h.sample.path = '/c/two';
    if (action === 'timeout') h.now += 30 * 60 * 1000;
    if (action === 'error') h.sample.errors = ['new-error'];
    h.tracker.tick();
    assert.equal(h.writes.length, 1, action);
    assert.notEqual(h.writes[0].status, 'completed');
    assert.equal(h.writes[0].durationMs, undefined);
    assert.equal(h.activeTimers, 0);
  }
});

test('新对话生成后的 URL 变化可继续观察，后续切页停止', () => {
  const h = setup(); h.sample.path = '/';
  h.tracker.attach(h.start(), 'entry');
  h.sample.path = '/c/created'; h.tracker.tick();
  assert.equal(h.writes.length, 0);
  assert.equal(h.sessionState.path, '/c/created');
  h.sample.path = '/c/other'; h.tracker.tick();
  assert.equal(h.writes[0].status, 'cancelled');
});

test('完成信号需稳定且生成标记仍在时不结束', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, replies: [{ key: 'new', nonempty: true, complete: true }] };
  h.now = 5000; h.tracker.tick(); h.now += 1000; h.tracker.tick();
  assert.equal(h.writes.length, 0);
  h.tracker.finish('cancelled');
});

test('回复底部操作按钮缺失时，停止生成结束且发送按钮恢复也能判定完成', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, ready: false, replies: [{ key: 'new', nonempty: true, complete: false }] };
  h.now = 4000; h.tracker.tick();
  h.sample = { ...h.sample, busy: false, ready: true, replies: [{ key: 'new', nonempty: true, complete: false }] };
  h.now = 6000; h.tracker.tick();
  h.now = 6500; h.tracker.tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.writes[0].completedAt, 6000);
});

test('超快回复未采到生成中、发送按钮和底部操作按钮时，回复稳定后仍能判定完成', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: false, ready: false, replies: [{ key: 'new', nonempty: true, complete: false, activity: '5:2' }] };
  h.now = 2000; h.tracker.tick();
  h.now = 2900; h.sample.replies[0].activity = '8:2'; h.tracker.tick();
  h.now = 4000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '内容最后变化后不足 1250ms 不应提前完成');
  h.now = 4150; h.tracker.tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.writes[0].completedAt, 2900);
});

test('只有确认回复完成才触发完成回调并保留问题上下文', () => {
  const h = setup();
  const completed = [];
  h.tracker.onComplete = (event) => completed.push(event);
  h.tracker.setEnabled(true);
  const request = h.tracker.start('chatgpt.com', null, { promptText: '请检查这个问题', pageUrl: 'https://chatgpt.com/c/1' });
  h.tracker.attach(request, 'entry');
  h.complete();
  assert.equal(completed.length, 1);
  assert.equal(completed[0].promptText, '请检查这个问题');
  assert.equal(completed[0].pageUrl, 'https://chatgpt.com/c/1');
  assert.equal(completed[0].status, 'completed');

  const h2 = setup();
  const cancelled = [];
  h2.tracker.onComplete = (event) => cancelled.push(event);
  h2.start();
  h2.tracker.finish('cancelled');
  assert.equal(cancelled.length, 0);
});

test('重新打开同一会话 URL 后恢复计时并保留原始发送时间', async () => {
  const h = setup();
  h.tracker.setEnabled(true);
  const request = h.tracker.start('chatgpt.com', null, { promptText: '刷新期间继续计时', pageUrl: 'https://chatgpt.com/c/one' });
  h.tracker.attach(request, 'entry');
  h.now = 5000;
  h.sample = { ...h.sample, busy: true, replies: [{ key: 'new', nonempty: true, complete: false }] };
  h.tracker.tick();
  assert.equal(h.sessionState.startedAt, 1000);
  assert.equal(h.sessionState.sawReply, true);

  h.activeTimers = 0;
  const Tracker = h.tracker.constructor;
  const restored = new Tracker({
    store: { async updateRequestTiming(id, data) { h.writes.push({ id, ...data }); } },
    sample: () => h.sample, now: () => h.now, onTick: (time) => h.ticks.push(time), session: h.session,
    interval: () => { h.activeTimers++; return 2; }, clear: () => h.activeTimers--
  });
  restored.setEnabled(true);
  await restored.restore('chatgpt.com');
  assert.equal(restored.active.startedAt, 1000);
  assert.equal(restored.active.entryId, 'entry');
  assert.ok(h.ticks.includes(4000));

  h.now = 9000;
  h.sample = { ...h.sample, busy: false, replies: [{ key: 'new', nonempty: true, complete: true }] };
  restored.tick();
  h.now = 9500;
  restored.tick();
  assert.equal(h.writes.at(-1).status, 'completed');
  assert.equal(h.writes.at(-1).startedAt, 1000);
  assert.equal(h.writes.at(-1).durationMs, 8000);
  assert.equal(h.sessionState, null);
});

test('默认计时器不以 RequestTiming 对象作为浏览器原生方法的 this', () => {
  let created = false, cleared = false;
  const env = { globalThis: {}, console,
    setInterval() { assert.notEqual(this?.constructor?.name, 'RequestTiming'); created = true; return 1; },
    clearInterval() { assert.notEqual(this?.constructor?.name, 'RequestTiming'); cleared = true; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/request-timing.js'), 'utf8'), env);
  const tracker = new env.globalThis.AIInputHistory.RequestTiming({ store: {}, onTick() {}, sample: () => ({ path: '/c/a', replies: [], busy: false }) });
  tracker.setEnabled(true); tracker.start('chatgpt.com'); tracker.finish('cancelled');
  assert.equal(created, true); assert.equal(cleared, true);
});
