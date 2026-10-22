# v1.37.14：Pro 剩余次数括号样式调整

日期：2026-10-22
代码目录：`C:\Codes\AIInputHistory`

## 需求

用户反馈在登录的 ChatGPT 输入框 Pro 右下角的 `≈15` 太显眼，希望直接显示为 **`(15)`**，仍锚定 Pro 文字右下侧，而不是顶部、箭头或语音区域。

## 改动

- `src/pro-badge.js` 仅改变“紧贴 Pro 的页面可见短文案”：去掉本地估算前缀 `≈`，数字加圆括号，例如 `(15)`。将原先绿色粗体换成取页面辅助文字颜色的 11px、medium 字重小字。
- **数据本身不改变**：`displayFor` 仍保存 `≈N` 的语义与本地估算计算方式；页面标记 `data-aih-pro-source=estimated`、鼠标悬停 `title` 和键盘无障碍 `aria-label` 仍提醒「本机估算、不等于官方剩余额度」。
- 更明确地区分无法确认为真实余额的情况：已知共享上限显示 `(≤N)`，未知显示 `(?)`；用户网页明确展示的真实数字显示 `(N)`。只有有效 Pro 选择控件及开关开启时显示。
- 保留已有模型识别、计数、防重复及 Pro 文字锚定定位，未改变权限或存储结构。没有清空原有数据。
- 单元测试增加估算、网页明确余额、共享上限、未知四种显示状态与来源说明的断言；浏览器回归覆盖 Pro → Instant → Pro、布局剪裁、React 重建及多视口下的括号文本与按钮位置。
- 验收使用已登录的 nuc11 MCP Chrome，验证真实 ChatGPT 输入框旁的括号值与截屏布局，不发送新聊天消息。

## 验证记录

（由后续自动化/实际 Chrome 验收填写。）
## 完成验证（2026-10-22）

- `npm test`：**277 / 277** 通过，0 失败、0 跳过。
- `npm run test:browser`：通过；原有请求计时 / Queue 验证、Pro 截断工具栏 / React 重建 / 模型切换、多视口下的括号小字、Chrome 隔离内容脚本测试均通过。
- `npm run build`：Manifest V3、31 个入口脚本校验通过；`npm run validate:store`：11 张图片、4 份文档通过。
- 在 **nuc11 Chrome DevTools MCP 的真实已登录 ChatGPT 页面**中，在扩展管理页执行 Reload 并刷新聊天页面后直接读取 DOM：`version=1.37.14`，`state=shown`，可见模型 `Pro`，数字 `(15)`，来源 `estimated`。
- 实际位置：Pro 文字框 `left=862, right=886, top=630, bottom=656`；数字框 `left=887, right=907, top=653, bottom=665`（视口像素），紧贴其右下角。字体 `11px/500`，颜色 `rgb(143,143,143)`。
- `elementFromPoint` 命中数字元素，证明不是隐藏 DOM；与右侧 Dictate、Start Voice 按钮均无交叠。`title` 仍提及本机估算，`data-aih-pro-source=estimated` 保留。
- 修复已在 MCP Chrome 的实际已登录页面运行，**未发送聊天消息**；不是仅依赖模拟 DOM。

## 交付包和最终检查

- 安装包：`dist/ai-input-history-1.37.14.zip`，大小 **177015 字节**。
- ZIP 内 Manifest 确认 `1.37.14`；55/55 文件与工作目录计算的 SHA-256 一致，ZIP 条目为标准正斜杠。
- ZIP SHA-256：`1979854efd72f12ffa780f72ab8c7a1a07a5aa7d06cd5bb022f157e4d980db8d`。
- `git diff --check` 返回 0。没有提交 Git、推送或发布商店；保留用户已有工作区修改。
- MCP Chrome 已实际重新加载并刷新真实 ChatGPT 页面，数字显示为 `(15)`，本地历史和使用统计未清空。
