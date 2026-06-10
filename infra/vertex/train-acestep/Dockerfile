FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      git ffmpeg libsndfile1 \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

WORKDIR /workspace

# Install torch first (matched to CUDA 12.4 base) so the cache stays warm
# across train.py iterations.
RUN pip3 install --no-cache-dir torch==2.4.1 torchvision==0.19.1 torchaudio==2.4.1 \
    --index-url https://download.pytorch.org/whl/cu124

COPY requirements.txt /workspace/requirements.txt
RUN pip3 install --no-cache-dir -r /workspace/requirements.txt

# ACE-Step source — pinned to a known-good commit so re-builds are
# reproducible. Update CAREFULLY (training scripts change schemas).
ARG ACE_STEP_REPO=https://github.com/ace-step/ACE-Step.git
ARG ACE_STEP_REF=main
RUN git clone --depth=1 --branch ${ACE_STEP_REF} ${ACE_STEP_REPO} /workspace/ACE-Step \
    && pip3 install --no-cache-dir -e /workspace/ACE-Step

COPY train.py monitor.py /workspace/

# Vertex AI invokes the container with our entrypoint; args (dataset URI,
# output URI, hyperparams) come from CustomJobSpec.workerPoolSpecs[0]
# .containerSpec.args.
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/workspace/train.py"]
