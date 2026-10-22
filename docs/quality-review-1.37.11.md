# v1.37.11：按用户截图修正 Pro 剩余数字位置

日期：2026-10-22。工作目录：C:\Codes\AIInputHistory。

## 用户要求

数字必须显示在 ChatGPT 输入框右侧原生 Pro 控件旁，具体为 Pro 文字右下侧、下拉箭头下方的空位（截图红色 14 标注处）。不是页面顶部模型选择器、历史悬浮入口，也不是麦克风或语音按钮。

## 复现与修改

在 tests/pro-anchor-fixture.html 中复现输入框、Pro 标签、下拉箭头、麦克风、语音按钮和另一个顶部模型入口。旧代码测试失败：期望 composer-pro，实际选中 header-pro。根因包括检测器直接排除 FOOTER 容器，且徽标允许回退到顶部模型入口。

src/pro-usage.js 保留原有计数用途的识别入口，新增 composerOnly 参数供数字徽标使用；允许输入框位于 footer 中，排除导航、顶部入口和聊天正文控件。src/pro-badge.js 通过文本 Range 得到 Pro 字样的矩形，按该文字右下角定位，不再按含箭头与空白的整个按钮盒子定位。徽标仍位于独立页面层以避开父级 overflow 裁切，但视觉位置严格贴着输入区 Pro 标签，不修改原按钮文案及事件。

数字去掉胶囊底色、边框及阴影，采用紧凑字体。本机估算仍保留 ≈，已有共享上限规则仍保留 ≤，未知数为 ?；悬停说明及无障碍标签保留来源和限制。这里没有更改额度规则，也没有从截图的示意数字 14 写入用户统计。

补充 characterData 监听以响应 React 只修改标签文字的模型切换，忽略徽标自身变化，避免观察器自触发循环。

## 验证范围

新增 tests/browser-pro-anchor-smoke.mjs，并加入 npm run test:browser：

- 只锚定输入框 Pro，不把数字显示在顶部模型入口；
- 数字左边缘贴着 Pro 文字右边缘，顶部贴着文字底边；
- 不覆盖麦克风；原生模型按钮仍能点击；
- 次数变化后更新，Pro → Instant → Pro 的文本节点更新后正确隐藏/恢复；
- React 替换模型按钮后重新锚定，不产生重复数字；
- 移除输入框 Pro 后不会回退到仍存在的顶部 Pro；
- 390、768、1260 像素窗口下保持位置。

原有 tests/browser-timing-smoke.mjs 的模型模拟入口改为真实输入区，并继续验证剪裁、菜单、计时、Queue、计数和按钮重建。新增三个单元回归，覆盖禁止顶部回退、footer 输入区和 Pro 文本矩形定位。

截图：dist/pro-composer-anchor-1.37.11.png。截图使用示例数据，不是用户的实际账号页面。

## 发布与限制

版本号、README、双语商店文案和提交清单已同步；截图脚本原本从 manifest 动态读取演示版本，无需硬编码更新。权限和数据结构未改变，不清空历史或 Pro 次数。未执行 Git commit、push 或商店发布。需要重新加载扩展并刷新已有 ChatGPT 页面；没有连接实际登录的浏览器页面，因此不声称已完成用户账号的线上验收。

## 最终验收

- npm test：273/273 通过，0 失败、0 跳过。
- npm run test:browser：完整计时/Queue 回归和新增截图定位回归均通过。
- npm run build、npm run validate:store、npm run package:store：均通过。
- 安装包：dist/ai-input-history-1.37.11.zip，175245 字节。
- 已逐项核对 ZIP 内全部 55 个文件 SHA-256，与对应源码/资源文件一致。
- ZIP SHA-256：bc5051e15fde524e3fa34b6622dbbad5ea1460c24b26bbc2e9c0e18b5bcc54ce。
- 已读取并检查浏览器生成的 pro-composer-anchor-1.37.11.png，数字位于输入框 Pro 文字右下侧，顶部入口无数字。
