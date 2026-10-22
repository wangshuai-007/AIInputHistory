# AI Input History Privacy Policy / AI 输入历史隐私政策

**Effective date / 生效日期：2026-10-22**

## 中文

AI 输入历史是一款以浏览器本地存储为默认方式的扩展，用于保存已支持或用户明确添加的 AI 网站中的输入草稿、自动快照和发送前内容，并提供搜索、筛选、恢复、AI 发送统计、ChatGPT Queue 排队、回复计时和可选的回复完成通知。

### 处理的数据

扩展可能处理：

- 用户在聊天输入框中主动输入的文本；
- 当前网站域名和页面标题，用于标识记录来源；
- 草稿、自动快照、发送状态和创建时间；
- ChatGPT Queue 中尚未发送的文本、队列顺序和发送确认状态；
- AI 发送统计所需的 AI 类型、总发送次数以及日/周/月发送次数；
- 主动开启 Pro 计数时的模型 / 模式、请求时间、脱敏请求编号、标签页编号、去重索引、本机用量与 HTTP 状态；网络观察器不保存原始请求体、提示词或认证信息；
- 开启回复计时或完成通知后，发送时间、网页观察到的回复完成时间、总耗时及状态；扩展不保存 GPT 回复正文；
- 通知调试日志中的渠道、检测方式、页面可见性、HTTP 状态等诊断字段；不记录问题正文、GPT 回复、Webhook 或 Token；
- 自定义域名、快捷键、语言、保存上限、界面位置和通知设置；
- 通知服务所需的 Webhook、Token、Headers 或 Body 模板；
- 当前网站的 favicon，仅用于网站筛选列表中的图标。

### 数据用途、存储与通知

历史、草稿、Queue、AI 发送统计、通知调试日志和设置保存在 `chrome.storage.local`。进行中的计时状态也保存在 `chrome.storage.local`，按域名及会话 ID 匹配；未分配会话 ID 时按标签页临时隔离。运行状态从发送或最近生成心跳起保留 30 分钟以供刷新和重新打开时恢复，持续生成的心跳可延长保留期，但原始起始时间不变；暂停状态最多保留至原始发送后的 24 小时。完成、取消、失败、超时或过期后清除。扩展没有开发者运营的服务器，不会把这些数据发送给开发者，也不会用于广告、画像、分析、出售或信用评估。

回复完成通知默认关闭。仅当用户主动启用第三方推送、企业群机器人或自定义 HTTP 通知时，扩展才会向用户选择的通知服务发送通知请求。内置通知默认只发送“ChatGPT 回复完成”和问题前 32 个字符的摘要；纯图片或附件请求发送通用提示，不发送 GPT 回复正文。
自定义 HTTP 请求允许用户在模板中显式使用 `{{question}}`、`{{pageUrl}}`、`{{duration}}` 等变量；使用这些变量意味着相应完整问题、页面地址或计时信息会被发送到用户配置的目标服务。Webhook、Token 等凭据仅保存在扩展本地，并只用于对应通知请求。

扩展可能请求当前网站的同源 favicon，仅用于显示图标；请求不携带 Cookie 或来源地址，不跟随重定向。通知 HTTP 请求使用 `credentials: omit` 和 `no-referrer`，不会主动携带目标网站 Cookie 或 ChatGPT Referer。为排查 Pro 模型识别问题，扩展会在 ChatGPT 网页的 `<html>` 元素中写入仅包含扩展版本和运行状态的诊断属性；网页脚本可读取这些属性，但不包含聊天正文、账号、请求 ID 或 Pro 计数数值。

### Pro 网络缓存与主动账号读取

Pro 计数默认关闭。开启后，观察器只读解析 ChatGPT 对话 POST 请求的模型 / 模式字段并检查 HTTP 结果，不修改请求，不读取聊天网络响应正文。启动时等待设置读取完成；关闭时不解析请求体。原始请求内容只在事件处理期间短暂存在，不写入网络缓存或诊断日志。

`chrome.storage.session` 中的 `aiInputHistoryProNetworkPending` 最多保留 150 条待确认请求的脱敏模型、模式、请求编号、标签页编号、接口路径、时间与状态；加载或下一次请求处理时淘汰超过 1 小时的记录，确认处理或关闭功能后清理。持久本机用量与有界去重索引保存在 `chrome.storage.local`，不是官方额度记录。

用户主动将「记录 Pro 模型次数」从关闭切换为开启时，会自动触发一次套餐读取；用户也可点击「读取当前账号套餐」手动重试。仅在这些操作触发时，扩展通过 ChatGPT 同源的登录会话、账号及成员列表接口尝试确认当前账号与本人席位。匹配可能处理当前用户 ID 或邮箱；原始账号响应、成员列表、身份信息及临时访问令牌不保存或导出。临时令牌仅在内存中用于 ChatGPT 同源请求。设置和诊断只保留套餐分类以及允许的脱敏席位字段 / 枚举，不上传到开发者服务器。

### 数据共享

默认情况下，输入历史不向第三方传输。用户主动开启 Bark、Server酱、PushPlus、ntfy、Gotify、钉钉机器人、飞书机器人、企业微信机器人或自定义请求后，通知数据会发送给用户选择并配置的服务。这属于用户主动指定的功能数据传输，扩展开发者不会接收这些通知内容或凭据。

### 数据保留和删除

未固定数据按照用户设置的历史上限保留。固定消息不会自动淘汰，也不会被“清空历史”操作删除，需要先解除固定。用户可以在扩展设置页或页面历史面板中清除未固定历史，卸载扩展会移除扩展本地数据。

### 权限

- `storage`：保存本地历史、草稿、计时、Pro 用量、设置、通知配置、图标缓存和界面位置，以及会话级脱敏网络元数据；
- `webRequest` 和 ChatGPT 必需网站权限：为主动开启的 Pro 统计观察 ChatGPT 对话请求模型 / 模式和 HTTP 状态，不跟踪其他网站流量；
- 可选 `notifications`：仅在用户选择浏览器系统通知时申请；
- 可选网站权限：仅在用户启用外部通知或测试通知时，按实际通知目标域名申请；
- 网站访问权限：识别支持的 AI 输入框并显示历史控件。非内置且未由用户添加的域名会被立即忽略。

### Limited Use

本扩展对用户信息的使用遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。数据仅用于扩展公开说明的功能。

### 联系方式

开发者支持邮箱：`support@wangshuai.app`

---
## English

AI Input History is local-first by default. It saves drafts, automatic snapshots, and text immediately before sending on supported or user-added AI sites, and provides search, filtering, restoration, per-AI send statistics, ChatGPT prompt queues, reply timing, and optional completion notifications.

### Data handled

The extension may handle chat input text, site domain and page title, drafts and sent timestamps, queued ChatGPT prompt text and queue state, per-AI total and day/week/month send counts, reply timing metadata, redacted notification-debug fields, custom domains, shortcuts, language and retention settings, UI positions, notification configuration, and same-origin favicons. Notification configuration may include Webhook URLs, tokens, custom headers, and body templates. Notification debug logs do not store prompt text, GPT replies, Webhooks, or tokens. GPT reply bodies are not stored.

### Purpose, storage, and notifications

History, drafts, queued prompts, send statistics, redacted notification debug logs, and settings are stored in `chrome.storage.local`. Active timing state is stored in `chrome.storage.local` and matched by host and conversation ID, with temporary per-tab isolation before an ID exists. Running state can be restored for 30 minutes after the start or latest generation heartbeat; continuing generation extends retention without changing the original start. Paused state is retained for at most 24 hours from the original start. It is cleared on completion, cancellation, failure, timeout, or expiry. The extension has no developer-operated server and does not send this data to the developer or use it for advertising, profiling, analytics, sale, or credit decisions.

To diagnose Pro model detection, the extension may add page-readable attributes to the ChatGPT `<html>` element containing only the extension version and a general runtime state. They do not contain chat text, account information, request IDs, or usage counts.

Completion notifications are off by default. Only when the user explicitly enables a third-party push provider, group robot, or custom HTTP notification does the extension send a notification request to the service selected by the user. Built-in providers send the completion title and, by default, only the first 32 characters of the prompt. Image-only or attachment-only requests use a generic message. GPT reply bodies are not sent.

Custom HTTP templates can explicitly include variables such as `{{question}}`, `{{pageUrl}}`, and `{{duration}}`; using them sends the corresponding prompt, page URL, or timing data to the configured destination. Webhook URLs and tokens remain in extension-local storage and are used only for notification delivery.
### Pro network metadata and user-initiated account reads

Pro counting is off by default. When enabled, the observer reads model/mode fields in ChatGPT conversation POST requests and their HTTP status, without modifying requests or reading chat response bodies. Processing waits for settings initialization; disabled counting does not parse request bodies. Raw request data exists only transiently during processing and is not written to network diagnostics or caches.

The `aiInputHistoryProNetworkPending` cache in `chrome.storage.session` holds at most 150 sanitized records: model/mode, request and tab IDs, endpoint path, time, and status. Records older than one hour are discarded when loading or processing another request; handled requests and disabled counting clear the relevant cache. Local usage aggregates and a bounded deduplication index persist in `chrome.storage.local`; they are not official quota records.

An explicit off-to-on change of Pro counting automatically triggers one plan lookup; the user can also retry with the account-plan button. Only these user actions cause the extension to query same-origin ChatGPT session, account, and member endpoints to identify the current account and the user's own seat. Matching may temporarily process the user's ID or email. Raw account responses, member lists, identity information, and temporary tokens are not retained or exported. In-memory tokens are used only for ChatGPT same-origin requests. Settings and diagnostics retain only plan classifications and allowlisted redacted seat schema/enums; none are uploaded to a developer server.

### Data sharing

By default, input history is not transmitted to third parties. If the user explicitly enables Bark, ServerChan, PushPlus, ntfy, Gotify, DingTalk robot, Feishu robot, WeCom robot, or a custom request, notification data is sent to the service chosen and configured by the user. This is a user-directed transfer for the requested feature; the extension developer does not receive the notification content or credentials.

Notification requests use `credentials: omit` and a no-referrer policy, so the extension does not intentionally attach target-site cookies or a ChatGPT Referer.

### Retention and deletion

Unpinned data is retained according to the configured history limits. Pinned entries are excluded from automatic retention and clear-history actions until unpinned. Users can clear unpinned history from the popup or in-page panel. Uninstalling the extension removes extension-local data.

### Permissions

- `storage`: stores local history, drafts, timers, Pro usage, settings, notification configuration, icons, UI positions, and sanitized session-level network metadata;
- `webRequest` and required ChatGPT host permissions: observe conversation request model/mode and HTTP status for user-enabled Pro counting, not for tracking traffic on other sites;
- optional `notifications`: requested only when browser/system notifications are selected;
- optional host permissions: requested for the actual destination domain only when an external notification or test is enabled;
- site access: detects supported AI composers and displays history controls. Domains that are neither built in nor user-added are ignored.

### Limited Use

The extension's use of user information follows the Chrome Web Store User Data Policy, including Limited Use requirements. Data is used only to provide the disclosed extension features.

### Contact

Publisher support email: `support@wangshuai.app`