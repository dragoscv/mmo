# Piper TTS on Cloud Run CPU (no GPU needed; Piper is tiny + fast).
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIPER_VOICES_DIR=/voices

RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY server.py .

RUN mkdir -p /voices

ENV PORT=8080
EXPOSE 8080
CMD ["gunicorn", "-w", "2", "--threads", "2", "--timeout", "120", "-b", "0.0.0.0:8080", "server:app"]
