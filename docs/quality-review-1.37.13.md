# v1.37.13：使用登录的 ChatGPT Chrome 实测 Pro 选中状态漏检

检查日期：2026-10-22
工作目录：`C:\Codes\AIInputHistory`

## 实际浏览器复现

连接 nuc11 上新启用的 `nuc11-chrome-devtools`，登录 ChatGPT 并进入正常会话，检查 Chrome 中**已安装的 1.37.12 解压扩展**，非仅运行模拟夹具。

- 插件正常加载，网页 `data-aih-pro-version=1.37.12`、`data-aih-pro-state=no-pro-control`、`[data-aih-pro-remaining]` 不存在。
- 实际会话输入框附近的模型选择器确实显示 `Pro`，不是顶部订阅标识。其可见按钮带 `aria-label="Select ChatGPT model"`、`aria-haspopup="menu"`。
- 同一个按钮的 `innerText === "Pro"`，而 `textContent === "Thinking effortPro"`。ChatGPT 内部的 `[aria-hidden="true"]` 节点使用 `visibility:hidden` 显示隐藏测量词 `Thinking effort`，用来测量按钮宽度。
- 旧版模型识别器读取 `textContent` 并拒绝混杂 `Thinking` 的标签，这是具体漏检根因，不能靠扩展重装或更改数字定位解决。

## 修复和可复现回归

- `src/pro-usage.js` 对已定位的模型控件读取**浏览器实际呈现的文本** `innerText`，仅当属性不存在时回退 `textContent`，排除不可见的测量文案。
- 保留严格的 `classifyModelLabel`（`Thinking effortPro` 本身依然判无效），避免因为放宽规则误计其他非 Pro 模式。
- `tests/pro-anchor-fixture.html` 在 Pro 模型按钮中加入与实际结构等效的隐藏测量 span：修复前 browser smoke 测试超时且无法创建徽标，修复后通过。
- `tests/pro-usage.test.js` 增加 `textContent='Thinking effortPro'`、`innerText='Pro'` 的回归测试；切换到 Instant 不产生 Pro 选中状态。

## 验证边界

扩展版本、页面状态、数字是否出现、屏幕上数字是否紧贴 Pro 文字，通过 Chrome DevTools MCP 在同一已登录会话中验证；不得把合成页面或普通单元测试当成真实登录页面的替代品。

本次不重置计数或历史、不发送聊天消息、不读取登录凭据、不更改 Chrome 配额记录。未提交、未推送、未商店发布。

## 真实登录浏览器验收结果（2026-10-22）

通过 AgentGateway 的 `nuc11-chrome-devtools` 检查**用户已登录的 ChatGPT 页面**，确认修复与模拟测试一致：

- 旧版（1.37.12）在真实页面中虽然选中 **Pro**，`data-aih-pro-state=no-pro-control`，数字不存在。可见按钮 `innerText="Pro"`，完整 `textContent="Thinking effortPro"`，隐藏测量词确实存在。
- 在 nuc11 的 Chrome 扩展管理页找到已解压加载的 `C:\Codes\AIInputHistory`，通过 Chrome UIA 对版本 **1.37.13** 的扩展点击 **Reload**；保留原设置与本机数据。
- 重新连接 DevTools MCP 后，同一已登录 ChatGPT 会话直接返回 `data-aih-pro-version=1.37.13`、`data-aih-pro-state=shown`、`[data-aih-pro-remaining].textContent="≈15"`，计数源标识为 `estimated`。
- 基于实际视口元素矩形：Pro 标签 `left=862..886, top=630..656`；数字 `left=887..909, top=653..667`，即 **Pro 文字右下角**，符合用户截图的红字位置。
- `getComputedStyle` 与 `elementFromPoint` 检查均确认数字真正可见、点击命中该元素；未遮挡 Dictate 或 Start Voice 语音按钮。
- 仅检查页面状态和 UI；**没有发送聊天消息**，没有修改模型套餐或 Pro 计数。

结论：**1.37.13 在已登录的真实 ChatGPT 页面成功显示预计剩余数字**。这个数字来自扩展本机估算，不代表 ChatGPT 官方确认的剩余额度。

## 完成验证及发布包

- 登录中的实际 ChatGPT 会话在重新加载页面后再次核实：`version=1.37.13`、`state=shown`、`count=≈15`、`model=Pro`，数字具有有效可视矩形。
- `npm test`：276/276 通过，0 失败、0 跳过。
- `npm run test:browser`：计时、Queue 与 Pro DOM 浏览器回归均通过。
- `npm run build`：通过，31 个 Manifest V3 入口文件完整；`npm run validate:store`：通过，11 张图片、4 份商店文件完整。
- `npm run package:store`：生成 `dist/ai-input-history-1.37.13.zip`，176902 字节，ZIP 内 manifest 为 `1.37.13`；55/55 条目与本地对应文件 SHA-256 全部一致，无反斜杠路径。
- ZIP SHA-256：`f17ae04bd2a65fab5510bc69c4c0dff447b81891d04426458413404bfe2a55a0`。
- `git diff --check` 通过；保留原本所有未提交改动。未创建 Git 提交、未推送、未发布商店。
