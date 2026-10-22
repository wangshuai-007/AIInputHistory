# AI 输入历史 v1.37.10：Pro 模型旁剩余次数显示修复

检查日期：2026-10-22
默认工作目录：`C:\Codes\AIInputHistory`

## 问题与复现

使用 ChatGPT 输入框的 Pro 模式时，v1.37.9 已能在少数模拟 DOM 中创建 `[data-aih-pro-remaining]` 徽标，但实现把徽标直接插在 Pro 模型按钮的后方，作为按钮的普通兄弟节点。在宽度受限、`overflow:hidden` 的工具栏中，徽标虽然存在于 DOM，却被裁切而不可见。

为此在 `tests/browser-timing-smoke.mjs` 构造了固定 76px、剪裁溢出的模型工具栏。修复前测试报告 `Remaining count must be visible beside Pro even if the toolbar clips overflow` 失败。另有现有模型检测器先读取文档范围内的模型选项，在菜单展开时可能优先定位到菜单项而不是输入区实际选中的 Pro 控件。

## 修复

- `src/pro-badge.js`：在 `document.body` 中创建独立定位的轻量级数值徽标，不直接修改 ChatGPT React 管理的模型按钮子树。根据按钮的视口矩形贴右侧放置，右侧空间不足时转至左侧，必要时置于上下方并限制在视口内。避开父级工具栏剪裁，窗口大小变化、滚动、DOM 改动及周期刷新时重新定位。
- 只在开启「记录 Pro 模型次数」且实际选中 Pro 模型时显示；计数变化后刷新数字；切换到普通模型或关闭开关时清除。
- 徽标提供文字说明、键盘可聚焦和来源属性：`剩余 N` 是 ChatGPT 页面明确展示的值；`≈N` 为用户确认套餐后的本机记录估算；未知套餐继续显示 `剩余 ?`，不捏造官方配额。
- Pro $200 的模型选择器若只显示笼统 `Pro` 而缺失具体型号，单个模型的真实剩余无法准确计算；此时显示 `≤N` 作为两个 Pro 模型共享的每日次数**上限**，并在说明文字中明确它不代表实际余额，模型单独限制可能更低。
- `src/pro-usage.js`：优先识别真实输入框附近的模型按钮，排除打开的模型菜单中的高亮选项；若版本名明确可与本地 Pro 选择控件关联，则保留该版本标识。

## 验证场景

- 固定宽度工具栏剪裁的反例与修复效果，使用浏览器 hit-test 验证数字真正可见，并且位于 Pro 按钮旁，不是仅存在于 DOM。
- 模型菜单有其他 Pro 选项仍使用真正的输入框 Pro 控件。
- React 替换模型按钮后重新定位；切换 Pro → Instant → Pro 时移除并恢复数字。
- Pro 次数增加后徽标值递减；关闭 Pro 计数立即移除；未知套餐及未知具体上限保留准确的状态标识。
- 测试命令：`npm test`、`npm run test:browser`、`npm run build`、`npm run validate:store`、`npm run package:store`。

## 使用与限制

在 `chrome://extensions` 或 `edge://extensions` 对本地扩展点击「重新加载」，刷新所有已打开的 ChatGPT 标签页。打开扩展弹窗，启用「记录 Pro 模型次数」，并确认本机推算所依据的 ChatGPT 套餐；选中 Pro 后会在模型按钮旁显示对应标识。没有确认套餐且网页没有明示官方剩余次数时显示问号是预期行为。

此版本没有新增网站权限、没有对数据存储结构进行破坏性变更，不会重置历史与 Pro 计数；不使用真实账户的隐藏数据接口获取官方额度，不承诺跨设备的剩余次数准确。浏览器模拟不等于对当前实际登录的 ChatGPT 网页完成了线上验收。

本次修改仅位于用户已有的未提交工作区中。未创建 Git commit、未推送、未上传商店。

## 完成验证记录（2026-10-22）

- `npm test`：**270 / 270 通过**，0 失败、0 跳过。
- `npm run test:browser`：通过；新的工具栏裁切、模型菜单、React 重建与 Pro/Instant 切换回归场景均通过。
- `npm run build`：通过，Manifest V3 的 31 个入口文件完整。
- `npm run validate:store`：通过，11 张图片与 4 份商店文档完整。
- `npm run package:store`：通过，包 `dist/ai-input-history-1.37.10.zip`，**174800 字节**，55 个 ZIP 条目，ZIP 内 manifest 版本已核实为 `1.37.10`。
- ZIP SHA-256：`d3b4e6ef9a1c59d1ca808de049ee45db72b58b60eb8280ef5134efb0a6f468a7`。
- `git diff --check`：通过，存在的 LF/CRLF 换行提示不代表语法或格式错误。
