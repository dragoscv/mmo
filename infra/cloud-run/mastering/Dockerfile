FROM python:3.12-slim

# FFmpeg + SoX for the mastering pipeline.
# - FFmpeg: download/upload, loudnorm, transcoding
# - SoX: 3-band EQ, multiband compression, stereo widening
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      sox libsox-fmt-all \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py /app/server.py

# Cloud Run injects PORT (default 8080). Gunicorn binds to it.
ENV PORT=8080
ENV PYTHONUNBUFFERED=1

# Workers=1 for small instance; mastering is sequential per request.
# Long timeout for big files (8 minutes max — Cloud Run cap is 60).
CMD ["sh", "-c", "exec gunicorn -b 0.0.0.0:${PORT} -w 1 --threads 2 --timeout 480 server:app"]
