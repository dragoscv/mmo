FROM python:3.11-slim

# CLAP needs torch + transformers + audio I/O (libsndfile via soundfile).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      libsndfile1 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install torch CPU-only — Cloud Run does not give us a GPU, and CLAP
# inference on a single audio file is fast enough on CPU (~2s for 10s
# of audio). For higher throughput, scale horizontally (Cloud Run does
# this automatically) instead of vertically.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.4.1 \
    && pip install --no-cache-dir -r requirements.txt

# Pre-download the CLAP weights into the image so cold starts are fast
# (~1.5 GB of weights vs ~10s download from HF on every cold start).
RUN python -c "from transformers import ClapModel, ClapProcessor; \
    ClapModel.from_pretrained('laion/larger_clap_music_and_speech'); \
    ClapProcessor.from_pretrained('laion/larger_clap_music_and_speech')"

COPY server.py /app/server.py

ENV PORT=8080
ENV PYTHONUNBUFFERED=1
ENV HF_HOME=/root/.cache/huggingface

CMD ["sh", "-c", "exec gunicorn -b 0.0.0.0:${PORT} -w 1 --threads 2 --timeout 300 server:app"]
