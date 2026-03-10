# CLAUDE.md - Claude Code メモ

## デプロイ注意事項

### support-base (Cloud Run)
- **デプロイ前に必ずgitのマージコンフリクトが残っていないか確認すること**
  - `grep -r "<<<<<<< " .` や `grep -r ">>>>>>> " .` で確認
  - 2026-03-10: コンフリクトマーカーが `live_session.py` に残ったままデプロイされ、SyntaxErrorでサービスがクラッシュした
- プロジェクト: `ai-meet-486502`
- リージョン: `us-central1`
- サービスURL: `https://support-base-32596857330.us-central1.run.app`
- ヘルスチェック: `/health`

### デプロイ手順 (support-base)
```bash
cd support-base
gcloud builds submit --tag gcr.io/ai-meet-486502/support-base --project ai-meet-486502
gcloud run deploy support-base \
  --image gcr.io/ai-meet-486502/support-base \
  --platform managed \
  --region us-central1 \
  --project ai-meet-486502
```
