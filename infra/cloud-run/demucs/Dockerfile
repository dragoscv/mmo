# Demucs stem separation on Cloud Run GPU (L4).
# Mirrors the companion `demucs_sidecar.py` API surface.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/root/.cache/huggingface \
    TORCH_HOME=/root/.cache/torch \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv python3-pip ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1

WORKDIR /app

# Torch + cu121 first (large layer, cache it).
RUN pip install --upgrade pip setuptools wheel && \
    pip install torch==2.4.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cu121

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY server.py .

ENV PORT=8080
EXPOSE 8080

CMD ["gunicorn", "-w", "1", "--threads", "1", "--timeout", "900", "-b", "0.0.0.0:8080", "server:app"]
