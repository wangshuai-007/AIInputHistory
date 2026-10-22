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
  h.promptFingerprint = env.globalThis.AIInputHistory.requestTimingModel.promptFingerprint;
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
  h.now = 9600; h.tracker.tick();
  assert.equal(h.writes.at(-1)?.id, 'A');
  assert.equal(h.writes.at(-1)?.status, 'completed');
  assert.equal(h.writes.at(-1)?.durationMs, 8600, '返回 A 后用 A 的原始发送时间计算耗时');
  assert.equal(h.writes.at(-1)?.observedAfterResume, true, '返回后才确认完成应标记时间上限');
  assert.equal(h.writes.at(-1)?.conversationId, 'one', '历史耗时记录应包含实际会话 ID');
  assert.equal(states.has('one'), false);
  assert.equal(states.has('two'), true);

  h.sample = { ...h.sample, path: '/c/two', replies: [{ key: 'reply-B', nonempty: true, complete: true }] };
  h.now = 12000;
  await h.tracker.restore('chatgpt.com', '/c/two');
  h.now = 12600; h.tracker.tick();
  assert.equal(h.writes.at(-1)?.id, 'B');
  assert.equal(h.writes.at(-1)?.status, 'completed');
  assert.equal(h.writes.at(-1)?.durationMs, 9600);
});

test('切回 A 时 React 仍保留 B 的完成回复，不能误结束 A；新页面就绪后结束 A', async () => {
  const h = setup();
  h.tracker.setEnabled(true);
  h.tracker.attach(h.tracker.start('chatgpt.com', null, { promptText: '会话 A 的问题' }), 'entry-A');
  h.now = 2000; h.sample.path = '/c/two'; h.tracker.tick();
  assert.equal(h.tracker.active, null);
  const expected = h.promptFingerprint('会话 A 的问题');
  const other = h.promptFingerprint('会话 B 的问题');
  h.now = 10_000;
  h.sample = { path: '/c/one', busy: false, errors: [], userActivities: [other],
    replies: [{ key: 'b-completed', nonempty: true, complete: true, afterLatestUser: true }] };
  await h.tracker.restore('chatgpt.com', '/c/one');
  h.now = 12_000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '上一个会话的完成标记不能被认作 A 已完成');
  assert.equal(h.tracker.active?.requestId != null, true, '应继续等待 A 的内容加载');
  assert.equal(h.diagnostics.at(-1)?.reason, 'conversation-content-not-ready');
  h.sample = { ...h.sample, userActivities: [expected],
    replies: [{ key: 'old-assistant', nonempty: true, complete: true, afterLatestUser: false },
      { key: 'a-completed', nonempty: true, complete: true, afterLatestUser: true }] };
  h.now = 13_000; h.tracker.tick();
  assert.equal(h.writes.length, 1, '恢复后看到真正属于 A 的完成回复应停止');
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.writes[0].observedAfterResume, true);
  assert.equal(h.tracker.active, null);
});

test('切回已完成的会话时没有复制按钮和曾经的 Stop 记录，3 秒稳定后结束计时', async () => {
  const h = setup();
  h.tracker.setEnabled(true);
  h.tracker.attach(h.tracker.start('chatgpt.com', null, { promptText: '后台生成任务 A' }), 'entry-A');
  h.now = 2000; h.sample.path = '/c/two'; h.tracker.tick();
  h.now = 10_000;
  h.sample = { path: '/c/one', busy: false, ready: false, errors: [],
    userActivities: [h.promptFingerprint('后台生成任务 A')],
    replies: [{ key: 'answer-A', nonempty: true, complete: false, activity: 'stable-A', afterLatestUser: true }] };
  await h.tracker.restore('chatgpt.com', '/c/one');
  assert.equal(h.tracker.active != null, true);
  h.now = 10_600; h.tracker.tick();
  h.now = 13_599; h.tracker.tick();
  assert.equal(h.writes.length, 0, '切回后只稳定不到 3 秒仍要等待');
  h.now = 13_600; h.tracker.tick();
  assert.equal(h.writes[0]?.status, 'completed', '不能因完成控件缺失一直保持计时');
  assert.equal(h.writes[0]?.observedAfterResume, true);
  assert.equal(h.writes[0]?.completedAt, 13_600);
});

test('切回后未生成新回复或只看见旧回复时不能误判完成', async () => {
  const h = setup();
  h.tracker.setEnabled(true);
  h.tracker.attach(h.tracker.start('chatgpt.com', null, { promptText: 'A 提问' }), 'entry-A');
  h.now = 2000; h.sample.path = '/c/two'; h.tracker.tick();
  h.now = 10_000;
  h.sample = { path: '/c/one', busy: false, errors: [], userActivities: [h.promptFingerprint('A 提问')],
    replies: [{ key: 'old', nonempty: true, complete: true, afterLatestUser: false }] };
  await h.tracker.restore('chatgpt.com', '/c/one');
  h.now = 30_000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '最后一次发送之后没有助手回复，不能用以前的复制按钮结束计时');
  h.sample.replies.push({ key: 'new', nonempty: true, complete: true, afterLatestUser: true });
  h.now = 31_000; h.tracker.tick();
  assert.equal(h.writes.at(-1)?.status, 'completed');
});

test('切回会话存在真实 Stop 按钮时持续观察，直到生成结束才完成', async () => {
  const h = setup();
  h.tracker.setEnabled(true);
  h.tracker.attach(h.tracker.start('chatgpt.com', null, { promptText: '交互式提问 A' }), 'entry-A');
  h.now = 2000; h.sample.path = '/c/two'; h.tracker.tick();
  h.now = 10_000;
  h.sample = { path: '/c/one', busy: true, buttonState: { processing: true, reason: 'stop-button' },
    errors: [], userActivities: [h.promptFingerprint('交互式提问 A')],
    replies: [{ key: 'choice-A', nonempty: true, complete: true, activity: 'awaiting-choice', afterLatestUser: true }] };
  await h.tracker.restore('chatgpt.com', '/c/one');
  h.now = 15_000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '有 Stop 按钮不能使用回复稳定兜底提前结束');
  h.sample = { ...h.sample, busy: false, buttonState: { processing: false, reason: 'no-stop-button' } };
  h.now = 16_000; h.tracker.tick();
  assert.equal(h.writes.at(-1)?.status, 'completed');
  assert.equal(h.writes.at(-1)?.observedAfterResume, false, '回到页面后仍在生成，完成时间为实时观测');
});

test('交互选项会暂停计时，选择后从冻结的秒数继续，结束不计算暂停时长', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'selection-entry');
  h.now = 3000;
  h.sample = { ...h.sample, busy: true, buttonState: { processing: true, reason: 'stop-button' },
    waitingForSelection: true, selectionTurnKey: 'choice-turn', replies: [{ key: 'choice', nonempty: true, complete: true }] };
  h.tracker.tick();
  assert.equal(h.tracker.active.pausedAt, 3000);
  assert.equal(h.ticks.at(-1), 2000);
  h.now = 13_000; h.tracker.tick();
  assert.equal(h.ticks.at(-1), 2000, '等待用户选择期间秒数不增长');
  h.tracker.selectionMade();
  assert.equal(h.tracker.active.pausedAt, null);
  assert.equal(h.tracker.active.pausedDurationMs, 10_000);
  h.now = 14_000; h.tracker.tick();
  assert.equal(h.tracker.active.pausedAt, null, '已选中的旧选项还在页面中不能重新暂停');
  h.now = 17_000;
  h.sample = { ...h.sample, busy: false, buttonState: { processing: false, reason: 'no-stop-button' },
    waitingForSelection: false, replies: [{ key: 'final', nonempty: true, complete: true }] };
  h.tracker.tick();
  assert.equal(h.writes.at(-1).status, 'completed');
  assert.equal(h.writes.at(-1).durationMs, 6000, '实际计时是累计运行的 2+4 秒');
});

test('同一页面先暂停但最终回复已完成，必须结束计时并清除运行状态', () => {
  const h = setup();
  const events = [];
  h.tracker.onComplete = (value) => events.push(value);
  const req = h.start();
  h.tracker.attach(req, 'reply-entry');
  h.now = 4000;
  h.sample = { ...h.sample, busy: true, buttonState: { processing: true, reason: 'stop-button' },
    waitingForSelection: true, selectionKind: 'explicit', selectionTurnKey: 'choice-turn',
    replies: [{ key: 'question', nonempty: true, complete: false, activity: 'choice-start' }] };
  h.tracker.tick();
  assert.equal(h.tracker.active.pausedAt, 4000);
  h.now = 7000;
  h.sample = { ...h.sample, busy: false, buttonState: { processing: false, reason: 'no-stop-button' },
    waitingForSelection: false, selectionKind: null,
    replies: [{ key: 'new-answer', nonempty: true, complete: true, activity: 'done' }] };
  h.tracker.tick('mutation');
  assert.equal(h.tracker.active, null, '完成后不得残留 paused 状态');
  assert.equal(h.writes.at(-1).status, 'completed');
  assert.equal(h.writes.at(-1).durationMs, 3000, '真正等待用户的 3 秒暂停需从总耗时中扣除');
  assert.equal(h.ticks.at(-1), null, '悬浮计时器应恢复普通图标');
  assert.equal(events.length, 1);
});

test('普通操作按钮导致的错误选择暂停在最终回复出现后撤销，并计入真实耗时', () => {
  const h = setup();
  const debug = [];
  h.session.debug = (event) => debug.push(event);
  h.tracker.attach(h.start(), 'false-selection');
  h.now = 4000;
  h.sample = { ...h.sample, busy: true, waitingForSelection: true, selectionKind: 'inferred',
    buttonState: { processing: true, reason: 'stop-button' }, selectionTurnKey: 'fake-choice',
    replies: [{ key: 'new', nonempty: true, complete: false, activity: 'generating' }] };
  h.tracker.tick();
  assert.equal(h.tracker.active?.pausedAt, 4000);
  h.now = 7200;
  h.sample = { ...h.sample, busy: false, buttonState: { processing: false, reason: 'no-stop-button' },
    waitingForSelection: true, selectionKind: 'inferred',
    replies: [{ key: 'new', nonempty: true, complete: true, activity: 'completed' }] };
  h.tracker.tick('mutation');
  assert.equal(h.tracker.active, null, '确认当前请求已经完成后不能一直卡在暂停');
  assert.equal(h.writes[0].status, 'completed');
  assert.equal(h.writes[0].durationMs, 6200, '误暂停期间仍应计入生成耗时');
  assert.ok(debug.some((entry) => entry.stage === 'timing-false-selection-recovered'));
});

test('真正的待选项即使有 Copy 按钮也必须等选择，不能提前标记完成', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'true-choice');
  h.now = 3100;
  h.sample = { ...h.sample, busy: false, buttonState: { processing: false },
    waitingForSelection: true, selectionKind: 'explicit', selectionTurnKey: 'choose-yes-no',
    replies: [{ key: 'await', nonempty: true, complete: true, activity: 'awaiting-user' }] };
  h.tracker.tick();
  assert.ok(Number.isFinite(h.tracker.active.pausedAt), '真正选择题要暂停');
  h.now = 45000; h.tracker.tick();
  assert.equal(h.writes.length, 0, '明确选择没有执行时，不可仅凭 Copy 控件误结束');
  assert.ok(Number.isFinite(h.tracker.active.pausedAt));
  h.tracker.selectionMade();
  h.sample = { ...h.sample, busy: true, buttonState: { processing: true },
    waitingForSelection: false };
  h.now = 46000; h.tracker.tick();
  h.sample = { ...h.sample, busy: false, buttonState: { processing: false },
    replies: [{ key: 'final', nonempty: true, complete: true, activity: 'finally' }] };
  h.now = 48000; h.tracker.tick();
  assert.equal(h.writes.at(-1)?.status, 'completed');
  assert.equal(h.writes.at(-1)?.durationMs, 5100, '只计算选择前 2.1 秒与选择后 3 秒');
});

test('老版本已误暂停的会话无需切换页面，遇到完成控件自动结算', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'old-stuck');
  h.now = 3000; h.tracker.setPaused(true, 'selection');
  // Old persisted state contains a pausedAt but no selectionKind metadata.
  assert.equal(h.tracker.active.selectionKind, null);
  h.now = 9000;
  h.sample = { ...h.sample, busy: false, waitingForSelection: false,
    replies: [{ key: 'finished', nonempty: true, complete: true, activity: 'final' }] };
  h.tracker.tick('mutation');
  assert.equal(h.tracker.active, null);
  assert.equal(h.writes[0]?.status, 'completed');
  assert.equal(h.writes[0]?.durationMs, 2000, '旧版暂停时长不应继续增长');
});

test('跨标签页恢复暂停状态时冻结数字，同步恢复的暂停时长不能被后续旧存档覆盖', async () => {
  const h = setup();
  const state = h.start();
  h.tracker.attach(state, 'entry');
  const version = state.pauseVersion + 1000;
  h.now = 4000;
  h.tracker.syncPause({ requestId: state.requestId, pauseVersion: version, pausedAt: 2500, pausedDurationMs: 500 });
  assert.equal(h.tracker.active.pausedAt, 2500);
  h.now = 9000;
  h.tracker.tick();
  assert.equal(h.ticks.at(-1), 1000, '跨标签页暂停期间显示应冻结');
  h.tracker.syncPause({ requestId: state.requestId, pauseVersion: version + 1, pausedAt: null, pausedDurationMs: 7000 });
  assert.equal(h.tracker.active.pausedAt, null);
  assert.equal(h.ticks.at(-1), 1000, '同步恢复后的秒数仍须扣除暂停时间');
  h.tracker.finish('cancelled');
});

test('切换会话和恢复观察写入诊断元数据，不记录问题正文', async () => {
  const h = setup();
  const events = [];
  h.session.debug = (event) => events.push(event);
  h.tracker.setEnabled(true);
  h.tracker.attach(h.tracker.start('chatgpt.com', null, { promptText: '这是敏感问题' }), 'debug-entry');
  h.sample.path = '/c/other';
  h.now = 2000; h.tracker.tick();
  assert.equal(h.tracker.active, null);
  assert.equal(events.filter((event) => event.stage === 'timing-observer-suspended').length, 1);
  h.sample.path = '/c/one';
  h.now = 3500;
  await h.tracker.restore('chatgpt.com', '/c/one');
  assert.equal(events.filter((event) => event.stage === 'timing-observer-restored').length, 1);
  assert.equal(events.every((event) => event.conversationId === 'one'), true);
  assert.equal(events.every((event) => event.requestId != null), true);
  assert.doesNotMatch(JSON.stringify(events), /这是敏感问题/);
  h.tracker.finish('cancelled');
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
  h.now = 10_700;
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

test('回复中临时 local-chatgpt 会话升级为正式 UUID 时持续计时，不触发挂起', () => {
  const h = setup();
  h.sample.path = '/';
  h.tracker.attach(h.start(), 'route-entry');
  const original = h.tracker.active.requestId;
  const provisional = '/c/local-chatgpt:aaaabbbb-1111-2222-3333-444455556666';
  const canonical = '/c/6acf1bda-6bc4-83ee-9b4e-6144bb94d490';
  h.sample = { ...h.sample, busy: true, path: provisional,
    buttonState: { processing: true, reason: 'stop-button' },
    replies: [{ key: 'stream', nonempty: true, complete: false, activity: 'still-streaming' }] };
  h.now = 1500; h.tracker.tick();
  assert.equal(h.tracker.active.requestId, original);
  assert.equal(h.sessionState.path, provisional);
  h.now = 4600;
  h.sample.path = canonical;
  h.tracker.tick();
  assert.equal(h.tracker.active?.requestId, original, '临时会话跳转正式 ID 不等于切换聊天');
  assert.equal(h.activeTimers, 1, '必须继续更新悬浮计时器');
  assert.equal(h.observerActive, true);
  assert.equal(h.sessionState.path, canonical, '同一请求持久化为真实会话路径');
  assert.equal(h.writes.length, 0, 'GPT 正在输出时不得记为完成或取消');
  assert.notEqual(h.ticks.at(-1), null);
  h.sample.path = '/c/another-chat';
  h.now = 5600; h.tracker.tick();
  assert.equal(h.tracker.active, null, '真正切换到其他会话仍应挂起');
  assert.equal(h.sessionState.path, canonical, '不应将其他会话误绑定');
});

test('发送按钮重复触发时如 GPT 已在生成，不能先取消原计时', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'active-entry');
  const before = h.tracker.active.requestId;
  h.sample = { ...h.sample, busy: true,
    buttonState: { processing: true, reason: 'stop-button' },
    replies: [{ key: 'stream', nonempty: true, complete: false, activity: 'text-partial' }] };
  h.now = 6100; h.tracker.tick();
  const attempted = h.tracker.start('chatgpt.com');
  assert.equal(attempted, null);
  assert.equal(h.tracker.active?.requestId, before, '重叠 submit/click 必须保留现有请求');
  assert.equal(h.activeTimers, 1);
  assert.equal(h.writes.length, 0, '不能产生 cancelled 历史记录');
});

test('读取 DOM 样本暂时失败时不能挂起或销毁正在回复的计时', () => {
  const h = setup();
  h.tracker.attach(h.start(), 'active-entry');
  const original = h.tracker.active.requestId;
  const originalSample = h.tracker.sample;
  h.tracker.sample = () => { throw new Error('transient React DOM remount'); };
  h.now = 3300;
  const attempted = h.tracker.start('chatgpt.com');
  assert.equal(attempted, null);
  assert.equal(h.tracker.active?.requestId, original, '捕获失败时不得清除上一请求');
  h.tracker.safeTick('mutation');
  assert.equal(h.tracker.active?.requestId, original, 'MutationObserver 采样异常仍需保留计时');
  assert.equal(h.activeTimers, 1);
  assert.equal(h.writes.length, 0);
  h.tracker.sample = originalSample;
  h.sample.busy = true;
  h.now = 5000; h.tracker.tick();
  assert.equal(h.tracker.active?.requestId, original);
});

test('只有真实生成确认后才触发 Pro 补计；采样暂时识别不到模型会继续重试', () => {
  const h = setup();
  const calls = [];
  h.tracker.onGenerationConfirmed = (request) => {
    calls.push({ requestId: request.requestId, at: h.now });
    return calls.length > 1;
  };
  h.tracker.attach(h.start(), 'entry');
  assert.equal(calls.length, 0, '点发送但尚未开始生成，不应记 Pro 次数');
  h.now = 1700; h.tracker.tick();
  assert.equal(calls.length, 0);
  h.sample = { ...h.sample, busy: true,
    buttonState: { processing: true, reason: 'stop-button' } };
  h.now = 2000; h.tracker.tick();
  assert.equal(calls.length, 1);
  assert.equal(h.tracker.active.generationSignalSent, undefined);
  h.now = 2200; h.tracker.tick();
  assert.equal(calls.length, 1, '识别失败时不能每 250ms 重试造成忙循环');
  h.now = 3001; h.tracker.tick();
  assert.equal(calls.length, 2);
  assert.equal(h.tracker.active.generationSignalSent, true);
  h.now = 5000; h.tracker.tick();
  assert.equal(calls.length, 2, '同一次生成只发出一个已确认补计信号');
  assert.equal(new Set(calls.map((call) => call.requestId)).size, 1);
});

test('恢复的旧计时器不能因为仍显示正在生成就再次触发 Pro 补计', () => {
  const h = setup();
  let fired = 0;
  h.tracker.onGenerationConfirmed = () => { fired++; return true; };
  h.tracker.attach(h.start(), 'entry');
  h.tracker.active.restored = true;
  h.tracker.active.restoredAt = 0;
  h.sample = { ...h.sample, busy: true };
  h.now = 5000; h.tracker.tick();
  assert.equal(fired, 0);
});

test('review: recently observed long generation restores with its original start time', async () => {
  const h = setup();
  h.now = 40 * 60_000;
  h.sessionState = {
    requestId: 'long-live-restore', site: 'chatgpt.com', path: '/c/one',
    startedAt: 1000, lastBusyAt: h.now - 1000, sawBusy: true
  };
  h.sample = { ...h.sample, busy: true, buttonState: { processing: true, reason: 'stop-button' } };
  h.tracker.setEnabled(true);
  const restored = await h.tracker.restore('chatgpt.com', '/c/one');
  assert.equal(restored?.requestId, 'long-live-restore');
  assert.equal(restored.startedAt, 1000);
  assert.equal(h.tracker.active?.requestId, 'long-live-restore');
  h.tracker.finish('cancelled');
});

test('review: stale saves without recent generation do not extend restore retention', async () => {
  const h = setup();
  h.now = 61 * 60_000;
  h.sessionState = {
    requestId: 'stale-restore', site: 'chatgpt.com', path: '/c/one',
    startedAt: 1000, lastBusyAt: 30 * 60_000, savedAt: h.now
  };
  h.tracker.setEnabled(true);
  assert.equal(await h.tracker.restore('chatgpt.com', '/c/one'), null);
  assert.equal(h.sessionState, null);
});
