const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const env = { globalThis: {}, console, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/request-timing.js'), 'utf8'), env);
  const h = { now: 1000, sample: { path: '/c/one', replies: [], busy: false, errors: [] }, writes: [], ticks: [], diagnostics: [], activeTimers: 0, observerActive: false, mutation: null, sessionState: null };
  h.session = {
    save(state) { h.sessionState = JSON.parse(JSON.stringify(state)); },
    async load() { return h.sessionState ? JSON.parse(JSON.stringify(h.sessionState)) : null; },
    clear() { h.sessionState = null; }
  };
  h.tracker = new env.globalThis.AIInputHistory.RequestTiming({
    store: { async updateRequestTiming(id, data) { h.writes.push({ id, ...data }); } },
    sample: () => h.sample, now: () => h.now, onTick: (time) => h.ticks.push(time),
    onDiagnostic: (event) => h.diagnostics.push(event), session: h.session,
    interval: () => { h.activeTimers++; return 1; }, clear: () => h.activeTimers--,
    observe: (callback) => {
      h.mutation = callback;
      h.observerActive = true;
      return { disconnect() { h.observerActive = false; } };
    }
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

test('长会话中 assistant 序号复用时，内容指纹变化仍识别为本次新回复', () => {
  const h = setup();
  h.sample.replies = [{ key: 'assistant-index:2', nonempty: true, complete: true, activity: 'old:1' }];
  h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, replies: [{ key: 'assistant-index:2', nonempty: true, complete: false, activity: 'new:1' }] };
  h.now = 3000; h.tracker.tick();
  assert.equal(h.tracker.active.sawReply, true, '相同 key 但内容指纹变化应视为新回复');
  h.sample = { ...h.sample, busy: false, ready: false, replies: [{ key: 'assistant-index:2', nonempty: true, complete: true, activity: 'new:final' }] };
  h.now = 5000; h.tracker.tick('mutation');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].status, 'completed');
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

test('关闭设置、超时和新错误都不虚构回复耗时', () => {
  for (const action of ['disable', 'timeout', 'error']) {
    const h = setup(); h.tracker.attach(h.start(), 'entry');
    if (action === 'disable') h.tracker.setEnabled(false);
    if (action === 'timeout') h.now += 30 * 60 * 1000;
    if (action === 'error') h.sample.errors = ['new-error'];
    h.tracker.tick();
    assert.equal(h.writes.length, 1, action);
    assert.notEqual(h.writes[0].status, 'completed');
    assert.equal(h.writes[0].durationMs, undefined);
    assert.equal(h.activeTimers, 0);
  }
});

test('新对话生成 ID 后迁移计时，之后切换会话只挂起而不取消', () => {
  const h = setup(); h.sample.path = '/';
  h.tracker.attach(h.start(), 'entry');
  h.sample.path = '/c/created'; h.tracker.tick();
  assert.equal(h.writes.length, 0);
  assert.equal(h.sessionState.path, '/c/created');
  assert.equal(h.sessionState.conversationId, 'created');
  h.sample.path = '/c/other'; h.tracker.tick();
  assert.equal(h.writes.length, 0, '切换会话不能把旧请求取消');
  assert.equal(h.tracker.active, null, '离开当前会话后挂起页面 DOM 检测');
  assert.equal(h.sessionState.path, '/c/created', '继续保留原会话 ID 与发送时间');
  assert.equal(h.activeTimers, 0);
});

test('按 ChatGPT 会话 ID 识别同一个对话，不受项目和 GPT 路由前缀影响', () => {
  const env = { globalThis: {}, console, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/request-timing.js'), 'utf8'), env);
  const model = env.globalThis.AIInputHistory.requestTimingModel;
  assert.equal(model.conversationIdFromPath('/c/abc-123'), 'abc-123');
  assert.equal(model.conversationIdFromPath('/g/gpt-name/c/abc-123'), 'abc-123');
  assert.equal(model.conversationIdFromPath('/project/folder/c/abc-123'), 'abc-123');
  assert.equal(model.conversationIdFromPath('/'), null);
  assert.equal(model.sameConversationPath('/c/abc-123', '/g/gpt-name/c/abc-123'), true);
  assert.equal(model.sameConversationPath('/c/abc-123', '/c/other'), false);
});

test('同一标签页 A→B→A 切换时各会话独立累计，返回 A 后恢复原始时间', async () => {
  const h = setup();
  const states = new Map();
  const key = (path) => path.match(/\/c\/([^/?#]+)/)?.[1] || path;
  const session = {
    save(state) { states.set(key(state.path), JSON.parse(JSON.stringify(state))); return { saved: true }; },
    async load(site, pathname) { return states.get(key(pathname)) || null; },
    clear(state) { states.delete(key(state.path)); }
  };
  h.tracker.session = session;
  h.tracker.attach(h.start(), 'A');
  h.sample = { ...h.sample, busy: true, replies: [{ key: 'reply-A', nonempty: true, complete: false }] };
  h.now = 2000; h.tracker.tick();
  h.sample = { ...h.sample, path: '/c/two', busy: false, replies: [] };
  h.now = 3000; h.tracker.tick();
  assert.equal(h.tracker.active, null);
  assert.equal(states.get('one').startedAt, 1000, '原会话仍在计时状态库中');
  assert.equal(h.writes.length, 0);

  await h.tracker.restore('chatgpt.com', '/c/two');
  assert.equal(h.tracker.active, null, 'B 没有已运行计时，可以正常新建');
  h.tracker.attach(h.start(), 'B');
  assert.equal(states.size, 2);
  h.sample = { ...h.sample, busy: true, replies: [{ key: 'reply-B', nonempty: true, complete: false }] };
  h.now = 4000; h.tracker.tick();
  h.sample = { ...h.sample, path: '/g/mygpt/c/one', busy: false,
    replies: [{ key: 'reply-A', nonempty: true, complete: true }] };
  h.now = 9000; h.tracker.tick();
  assert.equal(states.get('two').startedAt, 3000, 'B 的计时状态并未因切走被删除');
  await h.tracker.restore('chatgpt.com', '/g/mygpt/c/one');
  assert.equal(h.writes.at(-1)?.id, 'A');
  assert.equal(h.writes.at(-1)?.status, 'completed');
  assert.equal(h.writes.at(-1)?.durationMs, 8000, '返回 A 后用 A 的原始发送时间计算耗时');
  assert.equal(h.writes.at(-1)?.conversationId, 'one', '历史耗时记录应包含实际会话 ID');
  assert.equal(states.has('one'), false);
  assert.equal(states.has('two'), true);

  h.sample = { ...h.sample, path: '/c/two', replies: [{ key: 'reply-B', nonempty: true, complete: true }] };
  h.now = 12000;
  await h.tracker.restore('chatgpt.com', '/c/two');
  assert.equal(h.writes.at(-1)?.id, 'B');
  assert.equal(h.writes.at(-1)?.status, 'completed');
  assert.equal(h.writes.at(-1)?.durationMs, 9000);
});

test('同一个请求在两个标签页完成时，后台确认只允许写入和通知一次', async () => {
  const h = setup();
  const completions = [];
  let claimed = false;
  h.tracker.session.finalize = async () => {
    if (claimed) return { claimed: false };
    claimed = true;
    return { claimed: true };
  };
  h.tracker.onComplete = (value) => completions.push(value);
  h.tracker.attach(h.start(), 'shared');
  const second = new h.tracker.constructor({
    store: { async updateRequestTiming(id, data) { h.writes.push({ id, ...data }); } },
    sample: () => h.sample, now: () => h.now, onTick: () => {}, onComplete: (value) => completions.push(value),
    session: h.tracker.session, interval: () => 2, clear: () => {}, observe: () => null
  });
  second.setEnabled(true);
  await second.restore('chatgpt.com', '/c/one');
  assert.equal(second.active?.requestId, h.tracker.active?.requestId);
  h.now = 7000;
  h.sample = { ...h.sample, replies: [{ key: 'new', nonempty: true, complete: true }] };
  h.tracker.tick(); second.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completions.length, 1, '不能产生重复通知');
  assert.equal(h.writes.length, 1, '不能把同一会话重复保存为 completed');
  assert.equal(h.writes[0].durationMs, 6000);
});

test('完成信号需稳定且生成标记仍在时不结束', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, replies: [{ key: 'new', nonempty: true, complete: true }] };
  h.now = 5000; h.tracker.tick(); h.now += 1000; h.tracker.tick();
  assert.equal(h.writes.length, 0);
  h.tracker.finish('cancelled');
});

test('交互式回复出现完成控件，但停止图标仍在时持续计时并限频记日志', () => {
  const h = setup();
  const completed = [];
  h.tracker.onComplete = (event) => completed.push(event);
  h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, buttonState: { processing: true, reason: 'composer-stop-icon' },
    replies: [{ key: 'interactive-reply', nonempty: true, complete: true, activity: 'prompt-for-choice' }] };
  h.now = 3000; h.tracker.tick();
  h.now = 7000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '页面还在处理时不能写入 completed');
  assert.equal(h.activeTimers, 1, '保持定时器运行');
  assert.equal(h.observerActive, true, '保持 DOM observer 运行');
  assert.equal(h.diagnostics.length, 1, '30 秒内同状态不重复刷日志');
  assert.equal(h.diagnostics[0].reason, 'composer-stop-icon');
  assert.equal(completed.length, 0, '尚未完成不能触发通知');
  h.now = 34_000; h.tracker.tick();
  assert.equal(h.diagnostics.length, 2, '处理时间很长时仍可留下间隔诊断记录');

  h.sample = { ...h.sample, busy: false, buttonState: { processing: false, reason: 'no-stop-button' } };
  h.now = 35_000; h.tracker.tick();
  assert.equal(h.writes.at(-1).status, 'completed');
  assert.equal(h.writes.at(-1).completedAt, 35_000);
  assert.equal(completed.length, 1);
});

test('最终结束前二次采样，捕捉在首轮检查后出现的停止按钮', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'entry');
  const finishedReply = { ...h.sample, busy: false,
    replies: [{ key: 'new', nonempty: true, complete: true, activity: 'done' }] };
  let calls = 0;
  h.tracker.sample = () => {
    calls += 1;
    return calls === 1 ? finishedReply :
      { ...finishedReply, busy: true, buttonState: { processing: true, reason: 'stop-button' } };
  };
  h.now = 5000; h.tracker.tick();
  assert.equal(calls, 2, '必须在写入完成之前重新检查按钮');
  assert.equal(h.writes.length, 0);
  assert.equal(h.activeTimers, 1);
  assert.equal(h.diagnostics[0].status, 'completed');
  h.tracker.sample = () => finishedReply;
  h.now = 6000; h.tracker.tick();
  assert.equal(h.writes.at(-1).status, 'completed', '真正进入空闲后可以结束');
});

test('显示处理中按钮时不因异常标记或 30 分钟上限提前停止，手动取消不受影响', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, buttonState: { processing: true, reason: 'stop-button' },
    errors: ['temporary-error'] };
  h.now = 3000; h.tracker.tick();
  assert.equal(h.writes.length, 0);
  assert.equal(h.diagnostics[0].status, 'failed');
  h.sample.errors = [];
  h.now = 31 * 60 * 1000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '有停止按钮时允许超过常规超时阈值');
  assert.equal(h.diagnostics.at(-1).status, 'timeout');
  h.sample = { ...h.sample, busy: false, buttonState: { processing: false, reason: 'no-stop-button' } };
  h.now += 1000; h.tracker.tick();
  assert.equal(h.writes.at(-1).status, 'timeout', '处理状态确实消失且无回复时按超时收尾');

  const manual = setup();
  manual.tracker.attach(manual.start(), 'manual');
  manual.sample = { ...manual.sample, busy: true, buttonState: { processing: true, reason: 'stop-button' } };
  manual.tracker.finish('cancelled');
  assert.equal(manual.writes.at(-1).status, 'cancelled', '用户主动结束必须始终有效');
});

test('旧版 data-is-streaming 标记残留但回复明确完成并稳定 10 秒后会停止计时', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, streamingOnly: true, buttonState: { processing: false, reason: 'no-stop-button' },
    replies: [{ key: 'new', nonempty: true, complete: true, activity: 'final-text' }] };
  h.now = 2000; h.tracker.tick();
  h.now = 11_999; h.tracker.tick();
  assert.equal(h.writes.length, 0, '旧生成标记出现时应先等待回复稳定');
  h.now = 12_000; h.tracker.tick();
  assert.equal(h.writes.length, 1, '明确已完成且没有实际停止按钮，不应无限计时');
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.writes[0].completedAt, 12_000);
  assert.equal(h.diagnostics.at(-1).reason, 'stale-streaming-ignored', '修复残留标记时应记录成功收尾原因');
  assert.equal(h.activeTimers, 0);
});

test('真实停止按钮优先于残留生成标记的完成兜底，不能提前结束交互回复', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, streamingOnly: false, buttonState: { processing: true, reason: 'stop-button' },
    replies: [{ key: 'new', nonempty: true, complete: true, activity: 'choice-pending' }] };
  h.now = 2000; h.tracker.tick();
  h.now = 32_000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '真实 Stop 始终优先');
  assert.equal(h.activeTimers, 1);
  h.sample = { ...h.sample, busy: false, streamingOnly: false, buttonState: { processing: false, reason: 'no-stop-button' } };
  h.now = 34_000; h.tracker.tick();
  assert.equal(h.writes[0].status, 'completed');
});

test('只剩残留 streaming 属性且没有完成消息，30 分钟后按超时释放计时器', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: true, streamingOnly: true, buttonState: { processing: false, reason: 'no-stop-button' } };
  h.now = 31 * 60 * 1000; h.tracker.tick();
  assert.equal(h.writes.at(-1)?.status, 'timeout');
  assert.equal(h.activeTimers, 0);
});

test('弱生成标记完成确认前，二次检查出现真实 Stop 时继续计时', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  const reply = { key: 'new', nonempty: true, complete: true, activity: 'done' };
  const weak = { ...h.sample, busy: true, streamingOnly: true,
    buttonState: { processing: false, reason: 'no-stop-button' }, replies: [reply] };
  let guardStop = false;
  h.tracker.sample = () => guardStop
    ? { ...weak, busy: true, streamingOnly: false, buttonState: { processing: true, reason: 'stop-button' } }
    : weak;
  h.now = 2000; h.tracker.tick();
  h.now = 12_000; guardStop = false;
  h.tracker.sample = (() => { let count = 0; return () => ++count % 2
    ? weak : { ...weak, busy: true, streamingOnly: false, buttonState: { processing: true, reason: 'stop-button' } }; })();
  h.tracker.tick();
  assert.equal(h.writes.length, 0);
  assert.equal(h.diagnostics.at(-1).reason, 'stop-button');
  assert.equal(h.activeTimers, 1);
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

test('后台标签页定时器未调度时，DOM 变化仍能及时完成并停止观察', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'entry');
  assert.equal(h.observerActive, true);
  h.sample = { ...h.sample, busy: true, ready: false, replies: [{ key: 'new', nonempty: true, complete: false, activity: '4:2' }] };
  h.now = 3000;
  h.mutation();
  assert.equal(h.writes.length, 0);

  h.sample = { ...h.sample, busy: false, ready: true, replies: [{ key: 'new', nonempty: true, complete: false, activity: '20:5' }] };
  h.now = 5200;
  h.mutation();
  assert.equal(h.writes.length, 1, '不依赖 interval 再次执行也应完成');
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.observerActive, false, '完成后应释放 DOM observer');
  assert.equal(h.activeTimers, 0, '完成后也应释放轮询计时器');
});

test('未采到生成中和完成控件时，不能因发送按钮可用或短暂停顿提前结束', () => {
  const h = setup(); h.tracker.attach(h.start(), 'entry');
  h.sample = { ...h.sample, busy: false, ready: true, replies: [{ key: 'new', nonempty: true, complete: false, activity: '5:2' }] };
  h.now = 2000; h.tracker.tick();
  h.now = 2900; h.sample.replies[0].activity = '8:2'; h.tracker.tick();
  h.now = 8000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '新版页面发送按钮可用且回复暂停数秒时不得提前完成');
  h.now = 12_899; h.tracker.tick();
  assert.equal(h.writes.length, 0, '纯文本稳定兜底不足 10 秒仍不应完成');
  h.now = 12_900; h.tracker.tick();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.writes[0].completedAt, 12_900);
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
  assert.equal(completed[0].notificationEligible, true);

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
  const restoredCompletions = [];
  const restored = new Tracker({
    store: { async updateRequestTiming(id, data) { h.writes.push({ id, ...data }); } },
    sample: () => h.sample, now: () => h.now, onTick: (time) => h.ticks.push(time), onComplete: (event) => restoredCompletions.push(event), session: h.session,
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
  assert.equal(restoredCompletions.length, 1);
  assert.equal(restoredCompletions[0].notificationEligible, true);
  assert.equal(h.sessionState, null);
});

test('恢复时页面已存在新回复只补记完成，不补发通知', async () => {
  const h = setup();
  h.tracker.setEnabled(true);
  const request = h.tracker.start('chatgpt.com', null, { promptText: '本机旧问题', pageUrl: 'https://chatgpt.com/c/one' });
  h.tracker.attach(request, 'entry');
  const Tracker = h.tracker.constructor;
  h.activeTimers = 0;
  h.now = 10_000;
  h.sample = { path: '/c/one', busy: false, ready: true, errors: [], replies: [{ key: 'remote-reply', nonempty: true, complete: true, activity: '20:5' }] };
  const completed = [];
  const restored = new Tracker({
    store: { async updateRequestTiming(id, data) { h.writes.push({ id, ...data }); } },
    sample: () => h.sample, now: () => h.now, onTick: () => {}, onComplete: (event) => completed.push(event), session: h.session,
    interval: () => 2, clear: () => {}
  });
  restored.setEnabled(true);
  await restored.restore('chatgpt.com');
  h.now = 10_500;
  restored.tick();
  assert.equal(h.writes.at(-1).status, 'completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].notificationEligible, false);
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
