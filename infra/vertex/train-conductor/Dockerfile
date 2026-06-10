# Conductor (Maestro brain) trainer image.
#
# Built on top of CUDA 12.4 + PyTorch 2.5. The container expects to be
# invoked with the same CLI surface as the ACE-Step trainer so the
# `submit-training.py` submitter stays generic.

FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY requirements.txt .
RUN pip install --upgrade pip && pip install -r requirements.txt

COPY train.py monitor.py /workspace/

ENTRYPOINT ["python", "-u", "/workspace/train.py"]
