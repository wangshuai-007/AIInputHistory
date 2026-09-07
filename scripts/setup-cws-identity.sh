#!/usr/bin/env bash
# 在 Google Cloud Shell 中手动执行；不会创建服务账号密钥。
set -euo pipefail
PROJECT_ID="gen-lang-client-0197038767"
SERVICE_ACCOUNT="cws-api@${PROJECT_ID}.iam.gserviceaccount.com"
REPO="wangshuai-007/AIInputHistory"
POOL="aih-github"
PROVIDER="release"

echo "将授权 ${REPO} 的指定 tag 发布工作流以 ${SERVICE_ACCOUNT} 身份调用 API。"
echo "此账号还必须在 Chrome Web Store 后台关联；它具有发布者账号级商店权限。"
read -r -p "确认此权限绑定，输入 yes：" CONFIRM
[[ "$CONFIRM" == "yes" ]] || exit 1

gcloud services enable chromewebstore.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$PROJECT_ID"
gcloud iam service-accounts describe "$SERVICE_ACCOUNT" --project="$PROJECT_ID" >/dev/null
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
REPO_JSON=$(curl --fail --silent --show-error "https://api.github.com/repos/${REPO}")
REPO_ID=$(printf '%s' "$REPO_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
OWNER_ID=$(printf '%s' "$REPO_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["owner"]["id"])')
[[ "$PROJECT_NUMBER" =~ ^[0-9]+$ && "$REPO_ID" =~ ^[0-9]+$ && "$OWNER_ID" =~ ^[0-9]+$ ]]

# 查询失败会停止，不把权限错误误判为“资源不存在”。
POOLS=$(gcloud iam workload-identity-pools list --project="$PROJECT_ID" --location=global --format='value(name)')
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}"
if ! grep -Fxq "$POOL_NAME" <<< "$POOLS"; then
  gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" --location=global --display-name="AI Input History GitHub"
fi
PROVIDERS=$(gcloud iam workload-identity-pools providers list --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" --format='value(name)')
PROVIDER_NAME="${POOL_NAME}/providers/${PROVIDER}"
MODE="create-oidc"
if grep -Fxq "$PROVIDER_NAME" <<< "$PROVIDERS"; then MODE="update-oidc"; fi
CONDITION="assertion.repository_id == '${REPO_ID}' && assertion.repository_owner_id == '${OWNER_ID}' && assertion.event_name == 'push' && assertion.ref.startsWith('refs/tags/') && assertion.workflow_ref.startsWith('${REPO}/.github/workflows/chrome-store.yml@refs/tags/')"
gcloud iam workload-identity-pools providers "$MODE" "$PROVIDER" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id" \
  --attribute-condition="$CONDITION"
gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
  --project="$PROJECT_ID" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository_id/${REPO_ID}"
printf '\n在 GitHub 仓库 Actions Variables 中设置：\nCWS_WORKLOAD_IDENTITY_PROVIDER=%s\n' "$PROVIDER_NAME"
