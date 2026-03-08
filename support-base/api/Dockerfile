# Cloud Run用 Dockerfile
FROM python:3.11-slim

# 作業ディレクトリ
WORKDIR /app

# 依存関係をコピー・インストール
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションコードをコピー
COPY . .

# Cloud Runはポート8080を使用
ENV PORT=8080

# 起動コマンド
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
