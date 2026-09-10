# AI Input History Privacy Policy / AI 输入历史隐私政策

**Effective date / 生效日期：2026-09-10**

## 中文

AI 输入历史是一款以浏览器本地存储为默认方式的扩展，用于保存已支持或用户明确添加的 AI 网站中的输入草稿、自动快照和发送前内容，并提供搜索、筛选、恢复、ChatGPT 回复计时和可选的回复完成通知。

### 处理的数据

扩展可能处理：

- 用户在聊天输入框中主动输入的文本；
- 当前网站域名和页面标题，用于标识记录来源；
- 草稿、自动快照、发送状态和创建时间；
- 开启回复计时或完成通知后，发送时间、网页观察到的回复完成时间、总耗时及状态；扩展不保存 GPT 回复正文；
- 自定义域名、快捷键、语言、保存上限、界面位置和通知设置；
- 通知服务所需的 Webhook、Token、Headers 或 Body 模板；
- 当前网站的 favicon，仅用于网站筛选列表中的图标。

### 数据用途、存储与通知

历史、草稿和设置保存在 `chrome.storage.local`。扩展没有开发者运营的服务器，不会把这些数据发送给开发者，也不会用于广告、画像、分析、出售或信用评估。

回复完成通知默认关闭。仅当用户主动启用第三方推送、企业群机器人或自定义 HTTP 通知时，扩展才会向用户选择的通知服务发送通知请求。内置通知默认只发送“ChatGPT 回复完成”和问题前 32 个字符的摘要；纯图片或附件请求发送通用提示，不发送 GPT 回复正文。
自定义 HTTP 请求允许用户在模板中显式使用 `{{question}}`、`{{pageUrl}}`、`{{duration}}` 等变量；使用这些变量意味着相应完整问题、页面地址或计时信息会被发送到用户配置的目标服务。Webhook、Token 等凭据仅保存在扩展本地，并只用于对应通知请求。

扩展可能请求当前网站的同源 favicon，仅用于显示图标；请求不携带 Cookie 或来源地址，不跟随重定向。通知 HTTP 请求使用 `credentials: omit` 和 `no-referrer`，不会主动携带目标网站 Cookie 或 ChatGPT Referer。

### 数据共享

默认情况下，输入历史不向第三方传输。用户主动开启 Bark、Server酱、PushPlus、ntfy、Gotify、钉钉机器人、飞书机器人、企业微信机器人或自定义请求后，通知数据会发送给用户选择并配置的服务。这属于用户主动指定的功能数据传输，扩展开发者不会接收这些通知内容或凭据。

### 数据保留和删除

未固定数据按照用户设置的历史上限保留。固定消息不会自动淘汰，也不会被“清空历史”操作删除，需要先解除固定。用户可以在扩展设置页或页面历史面板中清除未固定历史，卸载扩展会移除扩展本地数据。

### 权限

- `storage`：保存本地历史、草稿、设置、通知配置、图标缓存和界面位置；
- 可选 `notifications`：仅在用户选择浏览器系统通知时申请；
- 可选网站权限：仅在用户启用外部通知或测试通知时，按实际通知目标域名申请；
- 网站访问权限：识别支持的 AI 输入框并显示历史控件。非内置且未由用户添加的域名会被立即忽略。

### Limited Use

本扩展对用户信息的使用遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。数据仅用于扩展公开说明的功能。

### 联系方式

开发者支持邮箱：`support@wangshuai.app`

---
## English

AI Input History is local-first by default. It saves drafts, automatic snapshots, and text immediately before sending on supported or user-added AI sites, and provides search, filtering, restoration, ChatGPT reply timing, and optional completion notifications.

### Data handled

The extension may handle chat input text, site domain and page title, drafts and sent timestamps, reply timing metadata, custom domains, shortcuts, language and retention settings, UI positions, notification configuration, and same-origin favicons. Notification configuration may include Webhook URLs, tokens, custom headers, and body templates. GPT reply bodies are not stored.

### Purpose, storage, and notifications

History, drafts, and settings are stored in `chrome.storage.local`. The extension has no developer-operated server and does not send this data to the developer or use it for advertising, profiling, analytics, sale, or credit decisions.

Completion notifications are off by default. Only when the user explicitly enables a third-party push provider, group robot, or custom HTTP notification does the extension send a notification request to the service selected by the user. Built-in providers send the completion title and, by default, only the first 32 characters of the prompt. Image-only or attachment-only requests use a generic message. GPT reply bodies are not sent.

Custom HTTP templates can explicitly include variables such as `{{question}}`, `{{pageUrl}}`, and `{{duration}}`; using them sends the corresponding prompt, page URL, or timing data to the configured destination. Webhook URLs and tokens remain in extension-local storage and are used only for notification delivery.
### Data sharing

By default, input history is not transmitted to third parties. If the user explicitly enables Bark, ServerChan, PushPlus, ntfy, Gotify, DingTalk robot, Feishu robot, WeCom robot, or a custom request, notification data is sent to the service chosen and configured by the user. This is a user-directed transfer for the requested feature; the extension developer does not receive the notification content or credentials.

Notification requests use `credentials: omit` and a no-referrer policy, so the extension does not intentionally attach target-site cookies or a ChatGPT Referer.

### Retention and deletion

Unpinned data is retained according to the configured history limits. Pinned entries are excluded from automatic retention and clear-history actions until unpinned. Users can clear unpinned history from the popup or in-page panel. Uninstalling the extension removes extension-local data.

### Permissions

- `storage`: stores local history, drafts, settings, notification configuration, cached icons, and UI positions;
- optional `notifications`: requested only when browser/system notifications are selected;
- optional host permissions: requested for the actual destination domain only when an external notification or test is enabled;
- site access: detects supported AI composers and displays history controls. Domains that are neither built in nor user-added are ignored.

### Limited Use

The extension's use of user information follows the Chrome Web Store User Data Policy, including Limited Use requirements. Data is used only to provide the disclosed extension features.

### Contact

Publisher support email: `support@wangshuai.app`