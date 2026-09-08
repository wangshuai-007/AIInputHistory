const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../scripts/cws-client.mjs');
const validation = import('../scripts/cws-validation.mjs');
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
  const { validateVersion } = await validation;
  validateVersion('1.24.0', '1.24.0', '1.24.0');
  assert.throws(() => validateVersion('v1.24.0', '1.24.0', '1.24.0'));
  assert.throws(() => validateVersion('1.24.0', '1.23.0', '1.24.0'));
});

test('CD 遵循 Chrome 版本范围并拒绝前导零和全零版本', async () => {
  const { validateVersion } = await validation;
  for (const version of ['0.0.0', '0.0.0.0', '01.0.0', '1.00.0', '65536.0.0', '1.2.3.99999999999999999999']) {
    assert.throws(() => validateVersion(version, version, version));
  }
  validateVersion('65535.0.1', '65535.0.1', '65535.0.1');
});

function releaseContext() {
  return {
    GITHUB_REPOSITORY: 'wangshuai-007/AIInputHistory', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/tags/1.24.0', GITHUB_REF_NAME: '1.24.0', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: 'wangshuai-007/AIInputHistory/.github/workflows/chrome-store.yml@refs/tags/1.24.0'
  };
}

test('CD 仅允许相符的原仓库 tag push 和指定工作流', async () => {
  const { validateReleaseContext } = await validation;
  for (const override of [
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: '--invalid' },
    { GITHUB_WORKFLOW_REF: 'wangshuai-007/AIInputHistory/.github/workflows/other.yml@refs/tags/1.24.0' }
  ]) {
    let calls = 0;
    assert.throws(() => validateReleaseContext({ ...releaseContext(), ...override }, () => { calls++; }));
    assert.equal(calls, 0);
  }
});

test('CD 校验事件提交、checkout 和 tag 一致且属于主线', async () => {
  const { validateReleaseContext } = await validation;
  const calls = [];
  validateReleaseContext(releaseContext(), (_command, args) => {
    calls.push(args);
    return 'a'.repeat(40);
  });
  assert.deepEqual(calls.at(-1), ['merge-base', '--is-ancestor', 'a'.repeat(40), 'origin/main']);
  for (const mismatch of ['refs/tags/1.24.0^{commit}', `${'a'.repeat(40)}^{commit}`]) {
    assert.throws(() => validateReleaseContext(releaseContext(), (_command, args) =>
      args.includes(mismatch) ? 'b'.repeat(40) : 'a'.repeat(40)), /不一致/);
  }
  assert.throws(() => validateReleaseContext(releaseContext(), (_command, args) => {
    if (args[0] === 'merge-base') throw new Error('git failure');
    return 'a'.repeat(40);
  }), /尚未合入/);
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
  for (const upload of [{ uploadState: 'FAILED' }, { uploadState: 'SUCCEEDED' },
    { uploadState: 'SUCCEEDED', crxVersion: '0.1.0' }]) {
    const { client, calls } = mock([{}, upload]);
    await assert.rejects(submit(client, '1.24.0', Buffer.from('zip'), pause));
    assert.equal(calls.some((call) => call[1] === 'publish'), false);
  }
});

test('CD 同步上传成功也会重新核对商店状态后再送审', async () => {
  const { submit } = await model;
  const { client, calls } = mock([{}, { uploadState: 'SUCCEEDED', crxVersion: '1.24.0' },
    {}, { state: 'PENDING_REVIEW' }]);
  await submit(client, '1.24.0', Buffer.from('zip'), pause);
  assert.deepEqual(calls.map((call) => call[1]), ['fetchStatus', 'upload', 'fetchStatus', 'publish']);
});

test('CD 拒绝覆盖后台进行中的上传', async () => {
  const { submit } = await model;
  for (const lastAsyncUploadState of ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']) {
    const { client, calls } = mock([{ lastAsyncUploadState }]);
    await assert.rejects(submit(client, '1.24.0', Buffer.from('zip'), pause), /上传正在处理/);
    assert.equal(calls.length, 1);
  }
});

test('CD 上传期间出现警告或其他待发布版本时停止送审', async () => {
  const { submit } = await model;
  for (const changed of [{ warned: true }, { takenDown: true },
    { submittedItemRevisionStatus: { state: 'STAGED' } }]) {
    const { client, calls } = mock([{}, { uploadState: 'IN_PROGRESS' },
      { lastAsyncUploadState: 'SUCCEEDED', ...changed }]);
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

test('CD 写请求的 HTTP 错误或无效响应不重试，并提示结果不确定', async () => {
  const { createClient } = await model;
  for (const response of [
    { status: 503, ok: false },
    { status: 200, ok: true, json: async () => { throw new Error('secret-token'); } },
    { status: 200, ok: true, json: async () => null }
  ]) {
    let calls = 0;
    const client = createClient('secret-token', 'publishers/x/items/y', async () => { calls++; return response; }, pause);
    await assert.rejects(client('POST', 'upload', Buffer.from('zip'), true), (error) =>
      /结果可能不确定/.test(error.message) && !error.message.includes('secret-token'));
    assert.equal(calls, 1);
  }
});

test('CD GET 无效 JSON 可重试且不输出远程响应', async () => {
  const { createClient } = await model;
  let calls = 0;
  const client = createClient('secret-token', 'publishers/x/items/y', async () => ({
    status: 200, ok: true, json: async () => {
      if (++calls < 3) throw new Error('secret-token');
      return { lastAsyncUploadState: 'SUCCEEDED' };
    }
  }), pause);
  assert.deepEqual(await client('GET', 'fetchStatus'), { lastAsyncUploadState: 'SUCCEEDED' });
  assert.equal(calls, 3);
});

test('CD 未知送审状态或警告不可宣称成功', async () => {
  const { submit } = await model;
  for (const result of [{}, { state: 'REJECTED' }, { state: 'PENDING_REVIEW', warningInfo: { warnings: [{}] } }]) {
    const { client } = mock([{}, { uploadState: 'SUCCEEDED', crxVersion: '1.24.0' }, {}, result]);
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
