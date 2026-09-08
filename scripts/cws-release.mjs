import { readFile, appendFile } from 'node:fs/promises';
import { createClient, submit } from './cws-client.mjs';
import { validateReleaseContext, validateVersion } from './cws-validation.mjs';

/** Runs tag validation or the authenticated store submission command. */
async function main() {
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  validateVersion(process.env.GITHUB_REF_NAME || '', manifest.version, pkg.version);
  validateReleaseContext(process.env);
  if (process.argv[2] === 'check') {
    if (!/^projects\/\d+\/locations\/global\/workloadIdentityPools\/[^/]+\/providers\/[^/]+$/.test(process.env.CWS_WORKLOAD_IDENTITY_PROVIDER || '')) {
      throw new Error('请先设置仓库 Actions variable：CWS_WORKLOAD_IDENTITY_PROVIDER。');
    }
    console.log('版本、主线和身份提供方配置校验通过。');
    return;
  }
  if (process.argv[2] !== 'publish') throw new Error('只支持 check 或 publish。');
  const publisher = process.env.CWS_PUBLISHER_ID;
  const extension = process.env.CWS_EXTENSION_ID;
  if (!/^[a-f0-9-]{36}$/.test(publisher || '') || !/^[a-p]{32}$/.test(extension || '')) {
    throw new Error('发布者或扩展 ID 无效。');
  }
  const archive = await readFile(`dist/ai-input-history-${manifest.version}.zip`);
  const message = await submit(createClient(process.env.CWS_ACCESS_TOKEN,
    `publishers/${publisher}/items/${extension}`), manifest.version, archive);
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Chrome Web Store\n\n版本：${manifest.version}\n\n${message}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
