import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const errors = [];

if (manifest.manifest_version !== 3) errors.push("manifest_version 必须为 3");
if (!manifest.permissions?.includes("storage")) errors.push("缺少 storage 权限");
if (!manifest.content_scripts?.[0]?.matches?.includes("<all_urls>")) errors.push("未启用全站输入框支持");

const referencedFiles = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...manifest.content_scripts.flatMap((script) => script.js || [])
].filter(Boolean);

if (!manifest.default_locale) errors.push("缺少 default_locale");
for (const locale of [manifest.default_locale, "en"]) {
  if (!fs.existsSync(path.join(root, "_locales", locale, "messages.json"))) errors.push(`缺少语言包: ${locale}`);
}

for (const relativePath of referencedFiles) {
  if (!fs.existsSync(path.join(root, relativePath))) errors.push(`缺少文件: ${relativePath}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`扩展校验通过：Manifest V3，${referencedFiles.length} 个入口文件完整。`);
}
