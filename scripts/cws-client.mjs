const HOST = 'https://chromewebstore.googleapis.com';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isUploading = (state) => ['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'].includes(state);
const stateLabel = (state) => /^[A-Z_]{1,40}$/.test(state || '') ? state : '未知';

function requestFailure(action, method, reason) {
  const instruction = method === 'GET' ? '请检查 API 权限和商店后台。'
    : '写入结果可能不确定，请先检查商店后台，不要盲目重试。';
  return new Error(`${action} ${reason}；${instruction}`);
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
        throw requestFailure(action, method, '网络失败');
      }
      if (method === 'GET' && (response.status === 429 || response.status >= 500) && attempt < 2) {
        await pause(1000 * 2 ** attempt);
        continue;
      }
      if (!response.ok) throw requestFailure(action, method, `HTTP ${response.status}`);
      let result;
      try {
        result = await response.json();
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('无效响应');
      } catch {
        if (method === 'GET' && attempt < 2) { await pause(1000 * 2 ** attempt); continue; }
        throw requestFailure(action, method, '响应无法解析');
      }
      if (result.error) throw new Error(`${action} 返回 API 错误，请检查商店后台。`);
      return result;
    }
  };
}

function checkStoreStatus(status, version) {
  const submitted = status.submittedItemRevisionStatus;
  const published = status.publishedItemRevisionStatus;
  const hasVersion = (revision) => revision?.distributionChannels?.some((item) => item.crxVersion === version);
  if (status.takenDown || status.warned) throw new Error('商店存在政策警告或下架状态，请先在后台处理。');
  if (hasVersion(published)) return '该版本已发布，未重复上传。';
  if (submitted?.state === 'PENDING_REVIEW' && hasVersion(submitted)) return '该版本正在审核，未重复提交。';
  if (['PENDING_REVIEW', 'STAGED'].includes(submitted?.state)) {
    throw new Error('已有版本正在审核或等待发布；不会自动取消或覆盖，请先处理。');
  }
  if (isUploading(status.lastAsyncUploadState)) throw new Error('商店已有上传正在处理，请先检查后台，不会覆盖上传。');
  return null;
}

async function waitForUpload(client, upload, version, pause) {
  if (upload.crxVersion && upload.crxVersion !== version) throw new Error('上传返回的版本不匹配，停止送审。');
  if (upload.uploadState === 'SUCCEEDED' && upload.crxVersion !== version) {
    throw new Error('上传成功但未返回版本，无法确认上传内容，停止送审。');
  }
  let state = upload.uploadState;
  let status;
  for (let attempt = 0; isUploading(state) && attempt < 30; attempt++) {
    await pause(5000);
    status = await client('GET', 'fetchStatus');
    state = status.lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') throw new Error(`上传未确认成功（${stateLabel(state)}），停止送审。`);
  return status || client('GET', 'fetchStatus');
}

/** 单次上传并等待处理，再请求常规审核与审核通过后自动发布。 */
export async function submit(client, version, archive, pause = sleep) {
  const existing = checkStoreStatus(await client('GET', 'fetchStatus'), version);
  if (existing) return existing;
  const upload = await client('POST', 'upload', archive, true);
  const status = await waitForUpload(client, upload, version, pause);
  const concurrent = checkStoreStatus(status, version);
  if (concurrent) return concurrent;
  const result = await client('POST', 'publish', {
    publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true
  });
  if (result.warningInfo?.warnings?.length) {
    throw new Error('商店返回发布警告，请检查后台；未自动忽略警告。');
  }
  if (!['PENDING_REVIEW', 'PUBLISHED', 'PUBLISHED_TO_TESTERS'].includes(result.state)) {
    throw new Error(`送审状态未确认（${stateLabel(result.state)}），请检查后台。`);
  }
  return '自动送审请求已受理；Google 审核通过后自动上架。这不代表已经审核通过。';
}
