FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

# Ubuntu 22.04 ships python3.10 by default. `python3-pip` from apt is wired
# to that 3.10 — so installing python3.11 alone leaves pip pointing at 3.10
# and every wheel lands in /usr/local/lib/python3.10. We bootstrap pip for
# 3.11 via ensurepip and then route `pip` to the 3.11 interpreter for the
# rest of the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 python3.11-venv python3.11-distutils \
      ffmpeg git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python \
    && ln -sf /usr/bin/python3.11 /usr/local/bin/python3 \
    && curl -sSL https://bootstrap.pypa.io/get-pip.py | python3.11 - "pip<25" setuptools wheel \
    && ln -sf /usr/local/bin/pip3.11 /usr/local/bin/pip \
    && ln -sf /usr/local/bin/pip3.11 /usr/local/bin/pip3

WORKDIR /app

# Install PyTorch with CUDA 12.1 wheels first (large; cached layer).
# torch 2.5+ accepts `torch.Tensor` annotations in custom-op infer_schema;
# 2.4.x rejected them with "Parameter q has unsupported type torch.Tensor"
# when ACE-Step's attention modules registered their kernels.
RUN python3.11 -m pip install --no-cache-dir \
      torch==2.5.1+cu121 torchaudio==2.5.1+cu121 \
      --extra-index-url https://download.pytorch.org/whl/cu121

COPY requirements.txt /app/requirements.txt
RUN python3.11 -m pip install --no-cache-dir -r requirements.txt

# ACE-Step itself (pulls transformers==4.50 — kept isolated in this image).
RUN python3.11 -m pip install --no-cache-dir \
      "git+https://github.com/ace-step/ACE-Step.git"

COPY server.py /app/server.py

# Cloud Run injects PORT (default 8080). Gunicorn binds to it.
ENV PORT=8080
ENV PYTHONUNBUFFERED=1
# HF cache lives inside the container so cold-start ⇒ download; later
# revisions reuse the layer cache. ACE-Step checkpoints (~6 GB) download
# on first /generate; subsequent calls within a warm instance are instant.
ENV HF_HOME=/root/.cache/huggingface
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface
ENV TORCH_HOME=/root/.cache/torch

# Workers=1 because each request uses the full GPU (L4 = 24 GB VRAM).
# Threads=1 so a single in-flight request doesn't fight CUDA for context.
# Long timeout: a 60s song at infer_step=60 ≈ 40 s GPU + overhead. 900s
# Cloud Run cap covers worst-case 180s songs.
CMD ["sh", "-c", "exec gunicorn -b 0.0.0.0:${PORT} -w 1 --threads 1 --timeout 900 server:app"]
