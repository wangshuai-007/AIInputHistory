# v1.37.15 — Pro 按钮内部括号数字，无插件提示

日期：2026-10-22
工作目录：`C:\Codes\AIInputHistory`

## 用户期望

此前 `(15)` 位于 **Pro 选择按钮框外**。用户要求把数字放到 ChatGPT 输入框真正的 Pro 模型按钮**内部**，且无需悬停提示或额外说明。

目标视觉效果：`Pro (15) ▾`。括号小数字稍低于 Pro 文字基线，仍位于原生按钮可点击范围，不遮挡箭头/麦克风。

## 登录页面的真实 DOM 与布局

通过 `nuc11-chrome-devtools` 在已登录的 ChatGPT 页面直接测量：

- 原始模型按钮 `aria-label="Select ChatGPT model"`、`display:flex`，原始 `column-gap:6px`；Pro 标签、下拉箭头同属该按钮。
- 原始按钮矩形约 `x846…920,y625…661`，Pro 标签 `x862…886`，箭头 `x892…908`。仅把外部绝对定位的小字向内移，会和箭头相撞。
- 不改变按钮 React 子节点的前提下，在 native button 上临时增大列间距，箭头仍在右侧、Pro 文本向左移动，新增 `(15)` 可放进两者之间，按钮可点击面积包住整个数字，未覆盖语音按钮。
- 通过真实 Chrome 截图初步验证目标布局，再将方案固化为扩展代码。

## 修改与回归

- `src/pro-badge.js`：新增 `reserveModelSpacing` 和 `releaseModelSpacing`，根据数字宽度暂时增大原生 model button 的 `column-gap`。仅调整 style（不插入 React 管理的按钮子树），ModelBadge 数字本身由不拦截指针的独立 body-level overlay 绘制，但视觉和点击位置**完全在模型按钮内部**。
- 借助 `data-aih-pro-gap` 保存原始 gap，避免 React `cloneNode` 复制 CSS 时越克隆越宽。切换模型、关闭计数或销毁徽标时恢复按钮的原始样式及删除标记。
- 数字元素设 `pointer-events:none`、`aria-hidden=true`；去掉 `title`、额外 `tabindex`、`aria-label`、帮助光标，避免插件提示弹窗或新增焦点。页面仅显示括号数字，不展示原先的估算说明气泡。
- 内部额度来源类型仍保留 `data-aih-pro-source` 以供诊断；无法确认时依然显示 `(?)`，仅有上限时显示 `(≤N)`，不制造精确配额。
- 浏览器测试断言计数**完全位于原生按钮内**且处于 Pro 文本与下拉箭头之间，数字上的指针事件仍交给原生 button；切换 Instant 时恢复 CSS，React clone 之后间距不重复增长，390/768/1260 宽度布局和语音按钮不重叠。

## 验证、限制、交付

- 已通过 nuc11 Chrome DevTools MCP **直接在已登录的真实 ChatGPT 页面**验收。重新加载 v1.37.15 的解压扩展并刷新对话后：`version=1.37.15`、`state=shown`、`count=(15)`、`model=Pro`。
- 真实尺寸：Pro 按钮左右坐标 **823.4–920.3px**、上下 **625.3–661.3px**；括号数字左右 **866–885.5px**、上下 **641–653px**，整个徽标完全在按钮矩形内。位于 Pro 文字后面、下拉箭头前面，不覆盖箭头和语音按钮。
- 数字不包含 `title`、`aria-label`、`tabindex`，且 `pointer-events:none`，指针命中的是原生 Pro 按钮（已通过 `elementFromPoint` 验证）。视觉字体 11px，灰色，无单独背景。
- `npm test`：277/277 通过，0 失败。
- `node tests/browser-timing-smoke.mjs`：通过，原有计时和 Queue 测试及按钮内部定位测试全部通过；`node tests/browser-pro-anchor-smoke.mjs`：通过，包括宽度变化、切换模型、React 重建、无提示与点击区域等。
- 用户本机所有历史、Pro 次数与设置保持不变；没有发送聊天消息、没有 Git 提交或商店发布。
## 最终验证（真实登录的 nuc11 Chrome）

- 在已登录 ChatGPT 上验证 1.37.14 原状态 `Pro`、旧徽标 `(15)` 位于按钮下方。经 Chrome DevTools 临时试排，将数字放入按钮实际矩形、移开箭头，真实截图确认视觉合理后再改源码。
- Chrome 扩展管理页通过 Windows UI Automation 确认 **AI Input History 1.37.15**，点击 Reload，不卸载、不删除计数和历史数据；随后重新加载当前 ChatGPT 会话。
- 通过 `nuc11-chrome-devtools.evaluate_script` 在真实页面读取：`version=1.37.15`、`state=shown`、`model=Pro`、`text=(15)`。
- **原生模型按钮实际矩形** `x823..920, y625..661`；Pro 标签 `x839..863`；**数字 `x866..886,y641..653`**；下拉箭头 `x892..908`。严格检查数字全部位于原生按钮内，且 Pro 标签与下拉箭头之间：`isInsideButton=true`、`betweenProAndArrow=true`。
- `document.elementFromPoint` 在数字中心命中模型原生按钮：`pointerHitsButton=true`、`pointerEvents=none`。没有覆盖 Dictate 或 Start Voice：`overlapsVoice=false`。
- `title` 为空、额外 `aria-label` 为空、非额外 Tab 焦点：`hasExtraTooltip=false`、`hasExtraAriaLabel=false`、`focusable=false`。
- 原生 Pro 控件的 `column-gap` 此时为 29px，换模型/关闭计数后扩展负责恢复原样。未执行任何聊天消息发送。
- Chrome DevTools 截图目视确认最终效果为紧凑的 `Pro (15) ▾`，整排文字在同一原生按钮内部。

## 代码、自动化、安装包

- `npm test`：**277/277 测试通过**、无失败。
- `npm run test:browser`：原有计时/Queue 验收及带 SVG 下拉箭头的真正“按钮内部”布局测试全部通过，验证切换 Instant 后样式还原、React 重新挂载按钮不会重复扩大间距、多视口不碰语音按钮。
- `npm run build`：31 个 Manifest V3 入口验证通过。
- `npm run validate:store`：11 张图片、4 份商店文档验证通过。
- `npm run package:store`：`dist/ai-input-history-1.37.15.zip`，**178041 字节**，ZIP 内 Manifest 1.37.15，55/55 条目与本地源码文件 SHA-256 完全一致，所有 ZIP 路径符合标准。
- ZIP SHA-256：`52c110c1efa729c596d02b724fd96f90ec565fd801cc1da560744c1533f45006`。
- `git diff --check`：返回 0；未提交、未推送、未商店发布。已有文件、计数和历史数据未被清空。
