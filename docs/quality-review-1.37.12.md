# AI 输入历史 v1.37.12：Pro 次数缺失与 Console 诊断修复

日期：2026-10-22。项目目录：`C:\Codes\AIInputHistory`。

## 用户实际反馈及解释

Chrome Console 输出 `document.querySelector('[data-aih-pro-remaining]') === null`，说明页面当时没有出现余额徽标。

直接执行 `AIInputHistory?.proUsageModel?.detect?.()` 会出现 `ReferenceError: AIInputHistory is not defined`，这不是扩展是否运行的有效证据：默认 DevTools Console 在**网页主世界（MAIN world）**执行，Manifest V3 的内容脚本在**隔离世界（ISOLATED world）**，命名空间默认彼此不共享。

## 复现并修复

1. **编辑器与 Pro 按钮不共享 DOM 祖先**：此前仅搜索编辑器向上八层 DOM 的控件，ChatGPT 若通过 React Portal / 深层工具栏呈现 Pro，即使按钮位置紧贴编辑器也会漏检。新增有界的几何邻近回退：从可见输入框/发送控件附近搜寻短 Pro 模型控件，过滤页面顶部模型、导航、菜单、聊天正文和升级按钮；不对网络通信做任何修改。独立 DOM 容器的浏览器回归测试在修复前报错、修复后通过。
2. **模型按钮以文字包含下拉箭头**：旧规则对 `Pro⌄`、`Pro▾`、`Pro▼`、`Pro⏷` 等文字无法识别。只把指定装饰箭头规范化为空格，保留排除 `Upgrade to Pro` / `Pro account` 的校验规则。隔离页面测试修复前报告 `no-pro-control`，修复后报告 `shown`。
3. **正确的 Console 诊断**：在 ChatGPT 页面的 `<html>` 上增加不含任何提示词、请求 ID、登录凭证、账号信息或计数数值的属性 `data-aih-pro-state`、`data-aih-pro-version`。该元数据页面脚本可见；不是访问特权扩展变量的后门，也不能操作设置或读取数据。

## 下一次诊断不再访问 AIInputHistory 全局变量

在安装并刷新 v1.37.12 后打开 ChatGPT 的 F12 → Console，输入：

```js
({
  extensionUI: !!document.querySelector('[data-ai-input-history="root"]'),
  version: document.documentElement.getAttribute('data-aih-pro-version'),
  state: document.documentElement.getAttribute('data-aih-pro-state'),
  count: document.querySelector('[data-aih-pro-remaining]')?.textContent ?? null
})
```

- `version: "1.37.12"`：可确认新诊断代码确实执行过。
- `state: "shown"`：页面已创建余额徽标。
- `state: "disabled"`：扩展中「记录 Pro 模型次数」设置未开启。
- `state: "no-composer"`：当前检测器没有找到已知 ChatGPT 编辑器。
- `state: "no-pro-control"`：编辑器可见，但没有匹配到已选 Pro 控件。
- `state: "module-loaded"`：模块文件已加载，但扩展页面初始化未走完。
- `version: null` 且 `state: null`：页面没有运行新版 Pro 模块；检查扩展安装来源、当前用户浏览器、站点访问权限、重新加载与页面刷新。它不必然表示扩展完全未加载。

这些字段不提供官方额度，余额仍依赖用户手动确认套餐、本浏览器的 Pro 次数以及 ChatGPT 网页明确显示的配额信息。未知上限不猜数字。

## 测试边界

- 浏览器模拟既覆盖普通页面又覆盖**Chrome 隔离 JavaScript World**：主世界 `AIInputHistory` 不存在、但共享 DOM 的诊断状态与余额元素可见。这与用户报告的 Console 行为一致。
- 同时测试 Pro 文字右下角定位、顶部入口排除、模型状态切换、DOM 节点重挂、跨根容器和带箭头文字、快照以及单元测试。
- 不使用用户真实登录会话，不触碰真实聊天内容或密钥，不能以模拟通过等同于当前真实 ChatGPT 网页的完整验收。
- 保留用户已存在的未提交工作区修改；不清空历史、使用次数、无需卸载，不提交 Git 或发布 Chrome Web Store。

## 最终验证与打包

- 完整自动化：`npm test` **275/275 通过**，无失败、跳过或取消。
- 浏览器端：`npm run test:browser` 全部通过，包括原有计时/Queue 验收、跨容器 Pro 目标识别、文本字符箭头与 Chrome 隔离 JS World；隔离世界测试中网页 `typeof AIInputHistory === "undefined"`，但 `data-aih-pro-state === "shown"` 且 `data-aih-pro-remaining === "≈14"`。
- `npm run build` / `npm run validate:store`：通过；Manifest V3 校验 31 个入口完整，商店校验 11 张图片、4 份文档。
- 修复 Windows 发布包使用 `\` 而非 `/` 作为 ZIP 条目路径分隔符的问题，确保跨系统解压兼容。
- 安装包：`dist/ai-input-history-1.37.12.zip`，**176717 字节**，55 个 ZIP 条目（使用正斜杠）；实际读取 ZIP 内 manifest 为 `1.37.12`，关键的 `src/pro-usage.js`、`src/pro-badge.js`、`src/content.js` 均已验证存在。
- ZIP SHA-256：`46bd5e80d1eebe095a32e13dd3d8f31138e217add7941f592df8f98bed42f4da`。
- 浏览器布局截图：`dist/pro-composer-anchor-1.37.12.png`，仅包含示例数据，不是当前登录账户截图。
- `git diff --check`：通过。保留所有现存未提交改动，没有创建 Git commit/tag、推送或上传商店。
