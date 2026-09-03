import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const expectedImages = new Map([
  ["assets/icons/icon-16.png", [16, 16]],
  ["assets/icons/icon-32.png", [32, 32]],
  ["assets/icons/icon-48.png", [48, 48]],
  ["assets/icons/icon-128.png", [128, 128]],
  ["store-assets/store-icon-128.png", [128, 128]],
  ["store-assets/promo-small-440x280.png", [440, 280]],
  ["store-assets/promo-marquee-1400x560.png", [1400, 560]],
  ["store-assets/screenshot-en-1280x800.png", [1280, 800]],
  ["store-assets/screenshot-zh-CN-1280x800.png", [1280, 800]]
]);
const requiredDocuments = [
  "store-assets/listing-en.md",
  "store-assets/listing-zh-CN.md",
  "store-assets/privacy-policy.md",
  "store-assets/submission-checklist.md"
];
const errors = [];

for (const [relativePath, expected] of expectedImages) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    errors.push(`缺少商店图片: ${relativePath}`);
    continue;
  }
  const data = fs.readFileSync(filePath);
  const actual = data.subarray(16, 24).length === 8 ? [data.readUInt32BE(16), data.readUInt32BE(20)] : [0, 0];
  if (actual[0] !== expected[0] || actual[1] !== expected[1]) errors.push(`${relativePath} 尺寸应为 ${expected.join("x")}，实际为 ${actual.join("x")}`);
}

for (const relativePath of requiredDocuments) {
  if (!fs.existsSync(path.join(root, relativePath))) errors.push(`缺少商店文档: ${relativePath}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`商店素材校验通过：${expectedImages.size} 张图片和 ${requiredDocuments.length} 份文档完整。`);
}
