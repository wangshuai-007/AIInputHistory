import { execFileSync } from 'node:child_process';

const REPOSITORY = 'wangshuai-007/AIInputHistory';

/** 在访问商店前验证项目版本约定与 Chrome 的版本数值限制。 */
export function validateVersion(tag, manifest, pkg) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(tag)
      || tag !== manifest || tag !== pkg) {
    throw new Error('版本 tag、manifest.json 和 package.json 的版本必须一致（不带 v，不含前导零）。');
  }
  const parts = tag.split('.').map(Number);
  if (parts.some((part) => part > 65535) || parts.every((part) => part === 0)) {
    throw new Error('Chrome 版本各段必须在 0 到 65535 之间，且不能全为零。');
  }
}

/** 确认当前提交就是触发发布的 tag，且已进入远程 main 历史。 */
export function validateReleaseContext(env, git = execFileSync) {
  const ref = `refs/tags/${env.GITHUB_REF_NAME}`;
  if (env.GITHUB_REPOSITORY !== REPOSITORY || env.GITHUB_EVENT_NAME !== 'push'
      || env.GITHUB_REF !== ref || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(env.GITHUB_REF_NAME || '')
      || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
      || env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/chrome-store.yml@${ref}`) {
    throw new Error('只允许原仓库指定工作流的版本 tag push 运行发布。');
  }
  const run = (...args) => git('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const head = run('rev-parse', '--verify', 'HEAD^{commit}');
  if (head !== run('rev-parse', '--verify', `${ref}^{commit}`)
      || head !== run('rev-parse', '--verify', `${env.GITHUB_SHA}^{commit}`)) {
    throw new Error('当前 checkout、版本 tag 和 GitHub 事件提交不一致，停止发布。');
  }
  try {
    run('merge-base', '--is-ancestor', head, 'origin/main');
  } catch {
    throw new Error('发布提交尚未合入 origin/main，或远程主线不可用，停止发布。');
  }
}
