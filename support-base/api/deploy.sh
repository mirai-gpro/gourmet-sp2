#!/bin/bash
# Cloud Run デプロイスクリプト

# 設定
PROJECT_ID="hp-support-477512"
REGION="asia-northeast1"
SERVICE_NAME="gourmet-voice-api"

echo "=== Cloud Run デプロイ ==="
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo "Service: $SERVICE_NAME"

# Docker イメージをビルド＆プッシュ
echo ""
echo ">>> Docker イメージをビルド中..."
gcloud builds submit --tag gcr.io/$PROJECT_ID/$SERVICE_NAME

# Cloud Run にデプロイ
echo ""
echo ">>> Cloud Run にデプロイ中..."
gcloud run deploy $SERVICE_NAME \
    --image gcr.io/$PROJECT_ID/$SERVICE_NAME \
    --platform managed \
    --region $REGION \
    --allow-unauthenticated \
    --set-env-vars "GOOGLE_API_KEY=${GOOGLE_API_KEY}"

echo ""
echo "=== デプロイ完了 ==="
gcloud run services describe $SERVICE_NAME --region $REGION --format "value(status.url)"
