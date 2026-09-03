# Chrome Web Store 提交清单

## 已准备文件

- 扩展上传包：`dist/ai-input-history-1.23.0.zip`
- 商店图标：`store-assets/store-icon-128.png`
- 小型宣传图：`store-assets/promo-small-440x280.png`
- Marquee 宣传图：`store-assets/promo-marquee-1400x560.png`
- 英文截图：`store-assets/screenshot-en-1280x800.png`
- 中文截图：`store-assets/screenshot-zh-CN-1280x800.png`
- 中文文案：`store-assets/listing-zh-CN.md`
- 英文文案：`store-assets/listing-en.md`
- 双语隐私政策：`store-assets/privacy-policy.md`

## Dashboard 建议填写

### Single purpose

Save and restore text the user enters into AI chat composers using browser-local history.

### `storage` 权限说明

Stores user-created prompt history, drafts, settings, cached site icons, and floating-interface positions locally in the browser. No history is sent to a developer server.

### 网站访问权限说明

The content script detects AI chat composers and displays the local-history controls. Built-in AI domains are enabled by default, and users may explicitly add other AI domains. On any domain that is neither built in nor user-added, the script exits immediately without recording input.

### 数据披露建议

如实选择与声明：

- Website content；
- User-generated content；
- Form data / Personal communications（若 Dashboard 提供对应分类）；
- Web browsing activity：仅域名和页面标题，用于标记记录来源；
- 数据仅保存在 `chrome.storage.local`；
- 不出售、不用于广告、不用于信用评估；
- 不向开发者服务器或第三方传输；
- 用途符合 Chrome Web Store User Data Policy 的 Limited Use 要求。

## 发布前仍需人工完成

- 将 `{{PUBLISHER_EMAIL}}` 替换为真实支持邮箱；
- 把隐私政策发布到公开 HTTPS 页面，并填写 Dashboard 的 Privacy policy URL；
- 填写开发者名称、支持 URL 和联系邮箱；
- 开启 Google 账号两步验证并完成开发者账号注册；
- 建议先选择 Unlisted 进行安装验收，通过后再改为 Public；
- 上传 ZIP 后检查自动安装测试，再提交审核。

## 权限审核提醒

当前内容脚本使用 `<all_urls>`，用于支持用户自行添加任意 AI 域名。该权限可能增加人工审核时间。商店说明、隐私政策和权限理由必须保持一致，不得声称扩展只访问固定站点。
