const HOST = 'https://chromewebstore.googleapis.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Validates tag/package consistency before any remote side effect. */
export function validateVersion(tag, manifest, pkg) {
  if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(tag) || tag !== manifest || tag !== pkg) {
    throw new Error('版本 tag、manifest.json 和 package.json 的版本必须一致（不带 v）。');
  }
}

/** Calls the official API; only read requests are retried automatically. */
export function createClient(token, name, fetcher = fetch, pause = sleep) {
  if (!token) throw new Error('缺少发布访问令牌。');
  return async (method, action, body, upload = false) => {
    const url = `${HOST}/${upload ? 'upload/' : ''}v2/${name}:${action}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await fetcher(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(90_000),
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': upload ? 'application/zip' : 'application/json' },
          ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) })
        });
      } catch {
        if (method === 'GET' && attempt < 2) { await pause(1000 * 2 ** attempt); continue; }
        throw new Error(`${action} 网络失败；写入结果可能不确定，请先检查商店后台，不要盲目重试。`);
      }
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
        await pause(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw new Error(`${action} HTTP ${response.status}；请检查 API 权限、版本和商店后台。`);
      const result = await response.json();
      if (result.error) throw new Error(`${action} 返回 API 错误，请检查商店后台。`);
      return result;
    }
  };
}

/** Uploads once, waits for processing, then requests normal review and automatic publication. */
export async function submit(client, version, archive, pause = sleep) {
  const before = await client('GET', 'fetchStatus');
  const submitted = before.submittedItemRevisionStatus;
  const published = before.publishedItemRevisionStatus;
  const hasVersion = (revision) => revision?.distributionChannels?.some((item) => item.crxVersion === version);
  if (before.takenDown || before.warned) throw new Error('商店存在政策警告或下架状态，请先在后台处理。');
  if (hasVersion(published)) return '该版本已发布，未重复上传。';
  if (submitted?.state === 'PENDING_REVIEW' && hasVersion(submitted)) return '该版本正在审核，未重复提交。';
  if (['PENDING_REVIEW', 'STAGED'].includes(submitted?.state)) {
    throw new Error('已有版本正在审核或等待发布；不会自动取消或覆盖，请先处理。');
  }
  const upload = await client('POST', 'upload', archive, true);
  if (upload.crxVersion && upload.crxVersion !== version) throw new Error('上传返回的版本不匹配，停止送审。');
  let state = upload.uploadState;
  for (let attempt = 0; ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(state) && attempt < 30; attempt++) {
    await pause(5000);
    state = (await client('GET', 'fetchStatus')).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error(`上传未确认成功（${state || '未知'}），停止送审。`);
  const result = await client('POST', 'publish', {
    publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true
  });
  if (result.warningInfo?.warnings?.length) {
    throw new Error('商店返回发布警告，请检查后台；未自动忽略警告。');
  }
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(result.state)) {
    throw new Error(`送审状态未确认（${result.state || '未知'}），请检查后台。`);
  }
  return '自动送审请求已受理；Google 审核通过后自动上架。这不代表已经审核通过。';
}
