# RVC voice conversion on Cloud Run GPU (L4).
# NOTE: voice-storage-in-GCS layer not yet shipped; service returns
# voice-not-found until per-user RVC models are uploaded.
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/root/.cache/huggingface \
    TORCH_HOME=/root/.cache/torch
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-venv python3.11-dev python3-pip ffmpeg ca-certificates curl libsndfile1 git \
        build-essential g++ \
    && rm -rf /var/lib/apt/lists/* \
    && update-alternatives --install /usr/bin/python python /usr/bin/python3.11 1 \
    && update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.11 1
WORKDIR /app
# Pin pip<24.1: fairseq pulls omegaconf<2.1 whose legacy metadata
# (`PyYAML (>=5.1.*)`) is rejected by the newer pip resolver.
RUN pip install --upgrade "pip<24.1" setuptools wheel && \
    pip install torch==2.4.1 torchaudio==2.4.1 --index-url https://download.pytorch.org/whl/cu121
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY server.py .
ENV PORT=8080
EXPOSE 8080
CMD ["gunicorn", "-w", "1", "--threads", "1", "--timeout", "900", "-b", "0.0.0.0:8080", "server:app"]
