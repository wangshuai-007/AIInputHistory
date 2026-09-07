# Chrome Web Store 自动送审

## 已配置

- GitHub：`wangshuai-007/AIInputHistory`，工作流 `.github/workflows/chrome-store.yml`。
- Cloud 项目：`gen-lang-client-0197038767`。
- 服务账号：`cws-api@gen-lang-client-0197038767.iam.gserviceaccount.com`。
- Publisher ID：`141cde73-f21a-45c1-9134-820d87a53558`。
- 扩展 ID：`gilopgljmiibhmmenfcomkhniipnepen`。

main 提交及 PR 只测试和打包；版本 tag push 在通过检查后上传并提交审核。审核由 Google 执行，通过后自动发布。不会绕过审核、取消其他版本的审核或忽略发布警告。工作流成功表示送审请求受理，不表示已经上架。

## 一次性启用

1. 确认 Chrome Web Store 后台已关联上述服务账号，并完成开发者邮箱、商店文案、隐私声明、分发配置。服务账号获得的是发布者账号范围权限，不是仅此扩展权限；不要给它额外的 Cloud Owner/Editor 权限。
2. 将 `scripts/setup-cws-identity.sh` 上传到 Google Cloud Shell，查看内容后运行 `bash "setup-cws-identity.sh"`。输入 `yes` 才创建或更新身份池并绑定服务账号。脚本需要有权限管理该项目 API、身份池及该服务账号 IAM 的登录账号。它不会生成私钥，也不会发布扩展。
3. 脚本会自动查询数字项目编号、GitHub 仓库及所有者的数字 ID，并将信任限制到这个仓库的 tag push 和指定工作流。若查询仓库失败，请停止并检查仓库可访问性，不要放宽身份条件。
4. 复制最后输出的 `projects/数字编号/locations/global/workloadIdentityPools/aih-github/providers/release`。
5. 打开 [仓库 Actions 配置](https://github.com/wangshuai-007/AIInputHistory/settings/variables/actions)，在 **Variables → New repository variable** 添加：名称 `CWS_WORKLOAD_IDENTITY_PROVIDER`，值为上一步完整地址。它不是密钥，不用放 Secrets。
6. 等待 IAM 配置传播（通常数分钟），再推送发布 tag。不要把服务账号 JSON 私钥或访问令牌提交到 GitHub。

当前机器未安装 gcloud/gh；本次只准备了本地工作流与脚本，未修改云端 IAM、GitHub Variables，也未推送代码或实际送审。

## 日常发布

1. 确保待发布提交已合入 main；更新 `manifest.json` 与 `package.json` 到相同的新版本。
2. 提交变更，创建同名 annotated tag（不带 v），然后推送 main 与这个 tag。
3. 在 GitHub Actions 中检查“Chrome Web Store”；校验失败时不会获取凭据或提交。
4. Actions 保存测试打包的 ZIP 30 天；发布 job 从相同提交重新打包并通过 OIDC 获取短期访问令牌。

现有 `1.24.0` tag 指向添加工作流之前的提交，不会包含新工作流。不要移动已发布 tag；下一次版本发布使用包含此工作流的新提交和新 tag。本次仅修改 CD，不提高扩展版本。

## 安全和失败处理

- Actions 固定完整 commit SHA，认证权限只授予 release job；PR 不获得发布 OIDC 权限。
- 建议在 GitHub Rulesets 限制 main、版本 tag 创建和修改权限，并保护工作流文件的审核。能够修改受信任工作流或创建发布 tag 的人可能获得发布权限。
- 发布 job 串行运行，不中断正在进行的上传。GitHub concurrency 可能替换尚未运行的旧排队任务；密集推送多个 tag 时应逐个检查。
- 只对 GET 状态查询自动重试，上传/送审 POST 不盲目重试。网络错误后先看商店后台，确认状态再重跑；已发布或在审的同版本会跳过。
- ZIP 已上传但送审失败时，先在商店后台解决问题并手动送审该上传版本；不保证相同版本的重新上传被接受。
- 正在审核或待发布的其他版本不会被自动取消。上传处理最多等待约 150 秒；超时保留后台状态供人工检查。
- 停止自动发布：禁用 GitHub 工作流。撤销访问：移除服务账号上的对应 `roles/iam.workloadIdentityUser` 绑定；不要删除共享服务账号。已发出的短期令牌可能在到期前仍有效，待审提交需在商店后台另行取消。
- 已发布版本不能靠移动 Git tag 回退；需以更高扩展版本提交修复。

## 官方参考

- [Chrome Web Store 服务账号](https://developer.chrome.com/docs/webstore/service-accounts)
- [Google GitHub Actions 身份认证](https://github.com/google-github-actions/auth)
- [上传接口](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload)
- [发布与审核接口](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
