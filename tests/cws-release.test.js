const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../scripts/cws-client.mjs');
const pause = async () => {};

function mock(responses) {
  const calls = [];
  return { calls, client: async (...args) => {
    calls.push(args);
    if (!responses.length) throw new Error('意外请求');
    return responses.shift();
  } };
}

test('CD 拒绝 tag 和包版本不一致', async () => {
  const { validateVersion } = await model;
  validateVersion('1.24.0', '1.24.0', '1.24.0');
  assert.throws(() => validateVersion('v1.24.0', '1.24.0', '1.24.0'));
  assert.throws(() => validateVersion('1.24.0', '1.23.0', '1.24.0'));
});

test('CD 异步上传完成后正常送审，不跳过审核', async () => {
  const { submit } = await model;
  const { client, calls } = mock([{}, { uploadState: 'IN_PROGRESS' },
    { lastAsyncUploadState: 'SUCCEEDED' }, { state: 'PENDING_REVIEW' }]);
  assert.match(await submit(client, '1.24.0', Buffer.from('zip'), pause), /已受理/);
  assert.deepEqual(calls.at(-1), ['POST', 'publish', {
    publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true
  }]);
});

test('CD 上传失败与版本不匹配时不发布', async () => {
  const { submit } = await model;
  for (const upload of [{ uploadState: 'FAILED' }, { uploadState: 'SUCCEEDED', crxVersion: '0.1.0' }]) {
    const { client, calls } = mock([{}, upload]);
    await assert.rejects(submit(client, '1.24.0', Buffer.from('zip'), pause));
    assert.equal(calls.some((call) => call[1] === 'publish'), false);
  }
});

test('CD 已发布或已送审的相同版本不重复上传', async () => {
  const { submit } = await model;
  for (const field of ['publishedItemRevisionStatus', 'submittedItemRevisionStatus']) {
    const { client, calls } = mock([{ [field]: {
      state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.24.0' }]
    } }]);
    await submit(client, '1.24.0', Buffer.from('zip'), pause);
    assert.equal(calls.length, 1);
  }
});

test('CD 不取消正在审核的其他版本', async () => {
  const { submit } = await model;
  const { client, calls } = mock([{ submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }]);
  await assert.rejects(submit(client, '1.24.0', Buffer.from('zip'), pause));
  assert.equal(calls.length, 1);
});

test('CD 写请求网络失败不重试、不泄露令牌', async () => {
  const { createClient } = await model;
  let calls = 0;
  const client = createClient('secret-token', 'publishers/x/items/y', async () => {
    calls++;
    throw new Error('secret-token');
  }, pause);
  await assert.rejects(client('POST', 'publish', {}), (error) => !error.message.includes('secret-token'));
  assert.equal(calls, 1);
});

test('CD GET 临时错误最多重试三次', async () => {
  const { createClient } = await model;
  let calls = 0;
  const client = createClient('token', 'publishers/x/items/y', async () => {
    calls++;
    return { status: 503, ok: false };
  }, pause);
  await assert.rejects(client('GET', 'fetchStatus'), /503/);
  assert.equal(calls, 3);
});

test('CD 未知送审状态或警告不可宣称成功', async () => {
  const { submit } = await model;
  for (const result of [{}, { state: 'REJECTED' }, { state: 'PENDING_REVIEW', warningInfo: { warnings: [{}] } }]) {
    const { client } = mock([{}, { uploadState: 'SUCCEEDED' }, result]);
    await assert.rejects(submit(client, '1.24.0', Buffer.from('zip'), pause));
  }
});

test('CD 上传超时有界且不会继续送审', async () => {
  const { submit } = await model;
  const { client, calls } = mock([{}, { uploadState: 'IN_PROGRESS' },
    ...Array.from({ length: 30 }, () => ({ lastAsyncUploadState: 'IN_PROGRESS' }))]);
  await assert.rejects(submit(client, '1.24.0', Buffer.from('zip'), pause), /停止送审/);
  assert.equal(calls.length, 32);
});
