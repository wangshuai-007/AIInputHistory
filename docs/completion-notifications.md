# ChatGPT 回复完成通知

AI Input History 可以在 ChatGPT Web 的一轮回复确认完成后发送通知。该功能默认关闭，与“跟踪请求耗时”开关相互独立：你可以只开启通知而不在历史记录中显示耗时。

通知只在扩展确认本轮回复正常完成时触发。取消生成、请求异常、切换到其他已有对话、超时或页面被关闭时不会发送“完成”通知。

## 默认通知内容

通知标题默认为 `ChatGPT 回复完成`。正文取本次发送给 ChatGPT 的问题前 32 个字符；超过 32 个字符时追加 `…`。发送纯图片或附件且没有文本时，正文显示 `图片或附件请求`。

例如：

```text
问题：请检查这个项目为什么图片发送后没有触发请求计时，并给出修改方案
通知：请检查这个项目为什么图片发送后没有触发请求计时，并给…
```

内置通知渠道只发送这段摘要，不发送 GPT 的回复正文。扩展也不会为了通知去读取或保存 GPT 回复正文。

## 支持的通知方式

- **浏览器通知**：使用 Chrome / Edge 的系统通知，不向第三方发送数据。
- **Bark**：填写完整 Bark 推送 URL，例如 `https://api.day.app/你的Key`。
- **Server酱**：填写 SendKey。
- **PushPlus**：填写 Token。
- **ntfy**：填写服务器地址（默认 `https://ntfy.sh`）和 Topic，支持自建服务。
- **Gotify**：填写服务器地址和 App Token，支持自建服务。
- **钉钉机器人**：粘贴群自定义机器人的完整 Webhook URL，发送 `text` 消息。
- **飞书机器人**：粘贴群自定义机器人的完整 Webhook URL，发送 `text` 消息。
- **企业微信机器人**：粘贴群机器人的完整 Webhook URL，发送 `text` 消息。
- **自定义请求**：自行配置 HTTP 请求，适合其他 Webhook、Home Assistant 或自建通知网关。

### 钉钉 / 飞书 / 企业微信机器人

三个企业群机器人都只需要粘贴群机器人设置页面生成的**完整 HTTPS Webhook URL**。Webhook URL 中通常已经包含 `access_token`、hook id 或 `key`，因此它本身就是发送凭据，不要提交到 Git、截图公开或发给无关人员。

内置机器人发送纯文本消息，内容固定为两行：第一行 `ChatGPT 回复完成`，第二行是问题前 32 个字符的摘要。这样不会把 GPT 回复正文或完整问题发送到群里。钉钉如果使用“自定义关键词”安全设置，可把 `ChatGPT` 配置为关键词，因为每条内置通知都会包含它。

目前内置模式直接使用 Webhook URL，不另外实现需要动态时间戳签名的机器人“加签”Secret。如果你的机器人强制要求签名，可改用机器人支持的关键词/IP安全方式，或使用你自己的中转服务再通过“自定义请求”调用。

## 自定义请求

自定义请求支持 `GET`、`POST`、`PUT`、`PATCH`，可以配置 URL、Headers JSON 和 Body。URL 中的主机名应保持固定，以便浏览器只授权实际目标域名。

可用模板变量：

| 变量 | 内容 |
| --- | --- |
| `{{title}}` | 默认通知标题 |
| `{{message}}` | 问题前 32 个字符的摘要，过长带 `…` |
| `{{question}}` | 完整问题文本；只有显式使用该变量时才会发送完整问题 |
| `{{duration}}` | 本轮从发送到完成的耗时，例如 `12.3s` |
| `{{completedAt}}` | 浏览器观察到的完成时间 |
| `{{pageUrl}}` | 发送时的 ChatGPT 页面地址 |

JSON Webhook 示例：

```text
方法：POST
URL：https://notify.example.com/api/push
Headers：{"Authorization":"Bearer YOUR_TOKEN","Content-Type":"application/json"}
Body：{"title":"{{title}}","message":"{{message}}","duration":"{{duration}}"}
```

如果目标服务需要完整问题，可以把 Body 中的 `{{message}}` 换成 `{{question}}`。需要注意，这会把完整问题发送给你配置的第三方服务。

`GET` 请求不会发送 Body；需要把变量放在 URL 查询参数中。Headers 必须是合法的 JSON 对象。

## 权限与隐私

通知功能默认关闭。浏览器通知开启时只申请可选的 `notifications` 权限。Bark、Server酱、PushPlus、ntfy、Gotify 或自定义请求只在开启或点击“发送测试通知”时申请目标服务对应的可选网站权限，不会在安装时直接获得所有外部网站访问权限。

推送地址、Token、Headers 和 Body 模板保存在 `chrome.storage.local`。扩展开发者没有服务器接收这些配置，也不会获得通知内容。

内置第三方渠道发送的正文使用 `{{message}}` 对应的 32 字摘要。自定义请求可能发送更多信息，实际范围完全由你使用的模板变量决定：

- 使用 `{{message}}`：只发送摘要；
- 使用 `{{question}}`：发送完整问题；
- 使用 `{{pageUrl}}`：发送本轮 ChatGPT 页面 URL；
- Headers 中填写的 Token 会作为请求凭据发送给对应目标服务。

所有外部请求由扩展 Service Worker 发出，设置 `credentials: omit` 和 `referrerPolicy: no-referrer`，不会主动附带目标网站的 Cookie 或 ChatGPT 页面 Referer。

## 测试配置

设置页提供“发送测试通知”按钮。测试通知使用固定测试文本，不会读取当前 ChatGPT 对话内容；按钮也会触发当前通知方式需要的可选权限申请。

如果测试失败，设置页会显示 HTTP 状态或配置错误。自定义服务需要自行确保目标接口允许扩展请求并能接受配置的请求格式。

## 与回复计时的关系

通知和“跟踪请求耗时”共用 ChatGPT 回复完成检测，但开关彼此独立。只开启通知时，扩展仍会在内部观察本轮是否完成，但不会因此给输入历史增加耗时展示；同时开启两项时，完成事件既更新历史耗时，也发送通知。

进行中的完成观察按 ChatGPT 会话 URL（域名 + pathname）临时保存在 `chrome.storage.local`。因此 F5、关闭标签页后重新打开同一 `/c/...` URL，甚至重启浏览器后重新打开该会话，都可以继续使用最初的发送时间观察本轮完成；打开其他会话 URL 不会恢复。新对话从 `/` 获得 `/c/...` 地址后，活动状态会迁移到确定的会话 URL。恢复状态最长保留 30 分钟，并在完成、取消、失败或超时后清除。

由于完成检测依赖 ChatGPT Web 的 DOM 状态和完成控件，ChatGPT 页面结构大幅调整后可能需要同步适配选择器。
