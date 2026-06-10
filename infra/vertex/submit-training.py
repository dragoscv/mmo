"""
Submit an ACE-Step LoRA training job to Vertex AI CustomJobs.

Usage (called from Next.js server action via `python infra/vertex/submit-training.py …`):

    python infra/vertex/submit-training.py \
        --exp-name my-style \
        --dataset-uri gs://mmo-training-prod/job-abc/dataset/ \
        --output-uri  gs://mmo-training-prod/job-abc/output/ \
        --max-steps 1500 \
        --spot

Emits the Vertex resource name and job id on stdout as one JSON line:
    {"ok": true, "jobName": "projects/…/locations/europe-west1/customJobs/123",
     "jobId": "123", "consoleUrl": "https://console.cloud.google.com/…"}
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from google.cloud import aiplatform  # type: ignore
from google.cloud.aiplatform.compat.types import (  # type: ignore
    custom_job as gca_custom_job,
)

PROJECT = os.environ.get("GCP_PROJECT_ID", "mmo-mw-prod")
REGION = os.environ.get("GCP_REGION", "europe-west1")
SERVICE_ACCOUNT = os.environ.get(
    "VERTEX_SERVICE_ACCOUNT",
    "sa-vertex-trainer@mmo-mw-prod.iam.gserviceaccount.com",
)
IMAGE_URI = os.environ.get(
    "VERTEX_TRAINER_IMAGE",
    f"{REGION}-docker.pkg.dev/{PROJECT}/mmo-training/acestep-trainer:latest",
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--exp-name", required=True)
    p.add_argument("--dataset-uri", required=True)
    p.add_argument("--output-uri", required=True)
    p.add_argument("--max-steps", type=int, default=1500)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--machine-type", default="a2-highgpu-1g",
                   help="GCE machine type (a2-highgpu-1g = 1×A100 40GB)")
    p.add_argument("--accelerator-type", default="NVIDIA_TESLA_A100")
    p.add_argument("--accelerator-count", type=int, default=1)
    p.add_argument("--spot", action="store_true",
                   help="Use spot VMs (much cheaper, preemption-safe via "
                        "checkpoint-every-200-steps).")
    p.add_argument("--timeout-hours", type=int, default=12)
    # Live monitor / control side-channel — forwarded to train.py.
    p.add_argument("--job-id", default=None,
                   help="training_jobs.id; when set, train.py POSTs events and polls control.")
    p.add_argument("--app-url", default=None,
                   help="Base URL of the Next.js app for webhook + control endpoints.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    aiplatform.init(project=PROJECT, location=REGION, staging_bucket=args.output_uri)

    container_args = [
        "--dataset-uri", args.dataset_uri,
        "--output-uri", args.output_uri,
        "--exp-name", args.exp_name,
        "--max-steps", str(args.max_steps),
        "--rank", str(args.rank),
        "--lr", str(args.lr),
        "--batch-size", str(args.batch_size),
    ]
    if args.job_id:
        container_args += ["--job-id", args.job_id]
    if args.app_url:
        container_args += ["--app-url", args.app_url]

    # Forward the trainer secret as a container env var. We read it from
    # this submitter's environment to avoid baking it into the image; the
    # Vertex container picks it up via $MMO_TRAINER_SECRET.
    trainer_secret = os.environ.get("MMO_TRAINER_SECRET", "")

    worker_pool_specs = [
        {
            "machine_spec": {
                "machine_type": args.machine_type,
                "accelerator_type": args.accelerator_type,
                "accelerator_count": args.accelerator_count,
            },
            "replica_count": 1,
            "disk_spec": {
                "boot_disk_type": "pd-ssd",
                "boot_disk_size_gb": 200,
            },
            "container_spec": {
                "image_uri": IMAGE_URI,
                # Explicit command guards against a stale image whose
                # ENTRYPOINT still points at the parent nvidia/cuda
                # nvidia_entrypoint.sh — without this, our `--dataset-uri`
                # gets fed to `exec` as a flag and the container exits 2.
                "command": ["python", "/workspace/train.py"],
                "args": container_args,
                "env": [
                    {"name": "MLFLOW_TRACKING_URI", "value": f"file:///workspace/mlruns"},
                    {"name": "CHECKPOINT_EVERY", "value": "200"},
                    *([{"name": "MMO_TRAINER_SECRET", "value": trainer_secret}] if trainer_secret else []),
                ],
            },
        }
    ]

    # spot pricing for a2-highgpu-1g in europe-west1 is ~$1.10/hr vs $3.67/hr on-demand
    # (Q4 2025). Use spot by default for LoRA training because we checkpoint every
    # 200 steps and the script auto-resumes from the last checkpoint on restart.
    job_kwargs: dict = {
        "display_name": f"acestep-lora-{args.exp_name}",
        "worker_pool_specs": worker_pool_specs,
    }

    try:
        job = aiplatform.CustomJob(**job_kwargs)
        # Spot via scheduling strategy — supported since aiplatform 1.36.
        run_kwargs: dict = {
            "service_account": SERVICE_ACCOUNT,
            "timeout": args.timeout_hours * 3600,
            "restart_job_on_worker_restart": True,
        }
        if args.spot:
            run_kwargs["scheduling_strategy"] = (
                gca_custom_job.Scheduling.Strategy.SPOT
            )

        # Async submit — return immediately so the caller (Next.js server action)
        # doesn't hold a 12h-long connection.
        job.submit(**run_kwargs)
        job_name = job.resource_name
        job_id = job_name.rsplit("/", 1)[-1]
        console_url = (
            f"https://console.cloud.google.com/vertex-ai/locations/{REGION}/"
            f"training/{job_id}?project={PROJECT}"
        )
        print(json.dumps({
            "ok": True,
            "jobName": job_name,
            "jobId": job_id,
            "consoleUrl": console_url,
        }), flush=True)
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
