#!/bin/bash
# ====================================
# support-base Cloud Run デプロイスクリプト
# ====================================
# 使い方: cd support-base && bash deploy.sh

set -e

# .env.deploy から環境変数を読み込み
if [ -f .env.deploy ]; then
  echo "📄 .env.deploy から環境変数を読み込み中..."
  export $(grep -v '^#' .env.deploy | grep -v '^$' | xargs)
else
  echo "❌ .env.deploy が見つかりません"
  echo "   .env.deploy を作成してください（.env.deploy.example を参照）"
  exit 1
fi

IMAGE_NAME="gcr.io/${PROJECT_ID}/${SERVICE_NAME}"

echo ""
echo "===================================="
echo " support-base デプロイ"
echo "===================================="
echo ""
echo "  Project:  ${PROJECT_ID}"
echo "  Service:  ${SERVICE_NAME}"
echo "  Region:   ${REGION}"
echo "  Image:    ${IMAGE_NAME}"
echo ""

# 1. プロジェクト設定
echo "[1/3] プロジェクト設定..."
gcloud config set project "${PROJECT_ID}"

# 2. イメージビルド
echo ""
echo "[2/3] Dockerイメージをビルド中..."
gcloud builds submit --tag "${IMAGE_NAME}" --project "${PROJECT_ID}"
echo "✅ ビルド完了"

# 3. Cloud Runにデプロイ
echo ""
echo "[3/3] Cloud Runにデプロイ中..."

# シークレット参照との競合を回避
echo "  既存のシークレット参照をクリア中..."
gcloud run services update "${SERVICE_NAME}" \
  --region "${REGION}" \
  --remove-secrets GEMINI_API_KEY \
  --project "${PROJECT_ID}" 2>/dev/null || true

gcloud run deploy "${SERVICE_NAME}" \
  --image "${IMAGE_NAME}" \
  --platform managed \
  --region "${REGION}" \
  --allow-unauthenticated \
  --set-env-vars "GEMINI_API_KEY=${GEMINI_API_KEY},PROMPTS_BUCKET_NAME=${PROMPTS_BUCKET_NAME},GOOGLE_PLACES_API_KEY=${GOOGLE_PLACES_API_KEY},TRIPADVISOR_API_KEY=${TRIPADVISOR_API_KEY},HOTPEPPER_API_KEY=${HOTPEPPER_API_KEY},SUPABASE_URL=${SUPABASE_URL},SUPABASE_KEY=${SUPABASE_KEY},AUDIO2EXP_SERVICE_URL=${AUDIO2EXP_SERVICE_URL}" \
  --memory 512Mi \
  --cpu 1 \
  --timeout 300 \
  --max-instances 10 \
  --project "${PROJECT_ID}"

echo "✅ デプロイ完了"

# URL取得
echo ""
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --region "${REGION}" \
  --format 'value(status.url)' \
  --project "${PROJECT_ID}")

echo "===================================="
echo " デプロイ完了!"
echo "===================================="
echo ""
echo " サービスURL: ${SERVICE_URL}"
echo ""
echo " 次のステップ:"
echo " 1. GCSバケット(${PROMPTS_BUCKET_NAME})にプロンプトをアップロード"
echo " 2. ${SERVICE_URL}/health にアクセスして動作確認"
echo " 3. フロントエンドの PUBLIC_API_URL に上記URLを設定"
echo ""
