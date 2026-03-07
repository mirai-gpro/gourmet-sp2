FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY support_base/ ./support_base/
COPY prompts/ ./prompts/

# ポート 8080（Cloud Run デフォルト）
EXPOSE 8080

# uvicorn で起動（WebSocket サポートのため直接使用）
CMD ["uvicorn", "support_base.server:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
