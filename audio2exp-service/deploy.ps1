gcloud run deploy audio2exp-service `
  --source . `
  --project hp-support-477512 `
  --region us-central1 `
  --memory 4Gi `
  --cpu 4 `
  --timeout 300 `
  --min-instances 1 `
  --cpu-boost `
  --set-env-vars "MODEL_DIR=/app/models,DEVICE=cpu,WARMUP_TIMEOUT=0,INFER_LOAD_TIMEOUT=1500,EXPRESSION_SCALE=1.8"

