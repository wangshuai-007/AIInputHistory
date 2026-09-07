# AI Input History Privacy Policy / AI 输入历史隐私政策

**Effective date / 生效日期：2026-09-04**

## 中文

AI 输入历史是一款仅在浏览器本地工作的扩展，用于保存用户在已支持或由用户明确添加的 AI 网站中输入的草稿、自动快照和发送前内容，并提供搜索、筛选与恢复功能。

### 处理的数据

扩展可能在启用的网站中处理以下数据：

- 用户在聊天输入框中主动输入的文本；
- 当前网站域名和页面标题，用于标识记录来源；
- 草稿、自动快照、发送状态和创建时间；
- 用户设置的自定义域名、快捷键、语言、保存上限和界面位置；
- 当前网站的 favicon，仅用于在网站筛选列表中显示图标。

### 数据用途和存储

这些数据仅用于提供扩展明确展示的本地输入历史功能。历史、草稿和设置保存在用户浏览器的 `chrome.storage.local` 中。扩展没有开发者服务器，不会把输入内容、历史记录或设置上传给开发者，也不会用于广告、画像、分析或出售。

扩展可能从用户当前访问的网站请求该网站自己的 favicon。该请求只用于显示网站图标，不会发送给开发者或其他第三方。

### 数据共享

扩展不会向开发者、广告平台、数据经纪商或其他第三方共享用户数据。除用户浏览器与用户正在访问的网站正常交互外，扩展不传输输入历史。

### 数据保留和删除

未固定数据会按照用户设置的历史上限保留。固定消息不会自动淘汰，也不会被清空历史操作删除，需要先解除固定。用户可以在扩展设置页或页面历史面板中清除未固定历史，也可以通过卸载扩展删除全部扩展本地数据。清除操作不可撤销。

### 权限

- `storage`：保存本地历史、草稿、设置、图标缓存和界面位置；
- 网站访问权限：识别支持的 AI 输入框并显示历史控件。扩展会立即忽略既不是内置 AI 网站、也未被用户添加的域名。

### Limited Use

本扩展对用户信息的使用遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。数据只用于提供扩展公开说明的单一用途。

### 联系方式

发布前请将此处替换为开发者支持邮箱：`support@wangshuai.app`

---

## English

AI Input History is a browser-local extension that saves drafts, automatic snapshots, and text immediately before sending on supported AI sites or domains explicitly added by the user. It provides local search, filtering, and prompt restoration.

### Data handled

On enabled sites, the extension may handle:

- Text the user actively enters into AI chat composers;
- The current site domain and page title, used to identify the source of an entry;
- Draft, automatic snapshot, sent status, and creation time;
- Custom domains, shortcut, language, retention limits, and interface positions configured by the user;
- The current site's favicon, used only in the site filter.

### Purpose and storage

This data is used only to provide the clearly disclosed local input-history feature. History, drafts, and settings are stored in `chrome.storage.local`. The extension has no developer-operated server and does not upload prompts, history, or settings to the developer. Data is not used for advertising, profiling, analytics, or sale.

The extension may request the favicon from the site the user is currently visiting. This request is used only to display that site's icon and is not sent to the developer or another third party.

### Data sharing

The extension does not share user data with the developer, advertising platforms, data brokers, or other third parties. Apart from normal interaction between the user's browser and the site being visited, input history is not transmitted.

### Retention and deletion

Pinned messages are excluded from automatic retention limits and clear-history actions. Unpin them before deletion. Uninstalling the extension still removes local data.

Unpinned data is retained according to the history limits configured by the user. Users can clear unpinned history from the extension settings or the in-page history panel. Uninstalling the extension also removes extension-local data. Deletion cannot be undone.

### Permissions

- `storage`: Stores local history, drafts, settings, cached icons, and interface positions;
- Site access: Detects supported AI composers and displays history controls. The extension immediately exits on domains that are neither built in nor explicitly added by the user.

### Limited Use

The use of information received by this extension adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements. Data is used only for the extension's disclosed single purpose.

### Contact

Replace this placeholder with the publisher support email before publishing: `support@wangshuai.app`
