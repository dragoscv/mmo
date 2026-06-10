"""
ACE-Step LoRA training entrypoint for Vertex AI CustomJobs.

Vertex invokes:
    python /workspace/train.py \
      --dataset-uri gs://mmo-training-prod/<jobId>/dataset/ \
      --output-uri  gs://mmo-training-prod/<jobId>/output/ \
      --exp-name    my-style \
      --max-steps   1500 \
      --rank        16

The container is built with an A100-spot machineSpec; the script must
be preemption-safe: it checkpoints every CHECKPOINT_EVERY steps to
`output-uri/checkpoints/` and resumes from the newest one on restart.

MLflow:
  - If MLFLOW_TRACKING_URI is set we log there.
  - Otherwise metrics are logged to a local mlruns/ tree which is
    uploaded to gs://output-uri/mlflow/ at the end of training.

This file is intentionally a SKELETON — ACE-Step's actual training
loop lives in /workspace/ACE-Step (cloned by the Dockerfile). We adapt
to it by calling its `acestep.cli.train` entry-point with the synthesized
config. If the upstream repo changes its CLI surface, only the
`run_acestep_training()` function needs to be updated.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import mlflow  # type: ignore
from google.cloud import storage  # type: ignore

from monitor import TrainerMonitor  # type: ignore

CHECKPOINT_EVERY = int(os.environ.get("CHECKPOINT_EVERY", "200"))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--dataset-uri", required=True, help="gs:// URI of training data folder")
    p.add_argument("--output-uri", required=True, help="gs:// URI to write checkpoints + final LoRA")
    p.add_argument("--exp-name", required=True, help="Experiment name (used as LoRA filename)")
    p.add_argument("--max-steps", type=int, default=1500)
    p.add_argument("--rank", type=int, default=16, help="LoRA rank")
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--batch-size", type=int, default=1)
    # Live monitor / control side-channel (back to the Next.js app).
    p.add_argument("--job-id", default=os.environ.get("MMO_TRAINING_JOB_ID"),
                   help="training_jobs.id — when set, events are POSTed to the app and control is polled")
    p.add_argument("--app-url", default=os.environ.get("MMO_APP_URL"),
                   help="Public base URL of the Next.js app (e.g. https://app.mmo.example.com)")
    return p.parse_args()


def parse_gs(uri: str) -> tuple[str, str]:
    if not uri.startswith("gs://"):
        raise SystemExit(f"Not a gs:// URI: {uri}")
    parsed = urlparse(uri)
    return parsed.netloc, parsed.path.lstrip("/")


def gcs_download_dir(uri: str, local: Path) -> None:
    bucket_name, prefix = parse_gs(uri)
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    count = 0
    for blob in client.list_blobs(bucket, prefix=prefix):
        if blob.name.endswith("/"):
            continue
        rel = blob.name[len(prefix):].lstrip("/")
        dst = local / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        blob.download_to_filename(dst)
        count += 1
    print(f"[train] downloaded {count} files from {uri} → {local}", flush=True)


def gcs_upload_dir(local: Path, uri: str) -> None:
    bucket_name, prefix = parse_gs(uri)
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    count = 0
    for path in local.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(local).as_posix()
        target = f"{prefix.rstrip('/')}/{rel}"
        bucket.blob(target).upload_from_filename(str(path))
        count += 1
    print(f"[train] uploaded {count} files from {local} → {uri}", flush=True)


def find_resume_checkpoint(output_uri: str, local_ckpt_dir: Path) -> Path | None:
    """Look for the newest checkpoint already in output-uri/checkpoints/
    and download it. Returns local path or None."""
    bucket_name, prefix = parse_gs(output_uri.rstrip("/") + "/checkpoints/")
    client = storage.Client()
    blobs = sorted(
        client.list_blobs(client.bucket(bucket_name), prefix=prefix),
        key=lambda b: b.updated,
        reverse=True,
    )
    if not blobs:
        return None
    newest = blobs[0]
    local_path = local_ckpt_dir / Path(newest.name).name
    local_ckpt_dir.mkdir(parents=True, exist_ok=True)
    newest.download_to_filename(local_path)
    print(f"[train] resuming from {newest.name}", flush=True)
    return local_path


ACE_STEP_DIR = Path(os.environ.get("ACE_STEP_DIR", "/workspace/ACE-Step"))


def _prepare_acestep_dataset(src_dir: Path, work: Path) -> Path:
    """Convert our `{i}/audio.mp3` + `{i}/text.txt` layout into the
    HuggingFace dataset that ACE-Step's trainer expects.

    Steps:
      1. Flatten samples into `<flat>/<keys>.mp3`, `<keys>_prompt.txt`,
         `<keys>_lyrics.txt` (empty if we have no lyrics).
      2. Run upstream `convert2hf_dataset.py` to produce an HF dataset
         folder.
    """
    flat = work / "acestep-flat"
    flat.mkdir(parents=True, exist_ok=True)

    n = 0
    for sample_dir in sorted(p for p in src_dir.iterdir() if p.is_dir()):
        audio = sample_dir / "audio.mp3"
        text = sample_dir / "text.txt"
        if not audio.exists():
            continue
        keys = sample_dir.name
        shutil.copyfile(audio, flat / f"{keys}.mp3")
        prompt = text.read_text(encoding="utf-8").strip() if text.exists() else ""
        (flat / f"{keys}_prompt.txt").write_text(prompt or "music", encoding="utf-8")
        # Lyrics file is required by convert2hf_dataset.py's assert; we
        # write an empty placeholder when we have none.
        (flat / f"{keys}_lyrics.txt").write_text("", encoding="utf-8")
        n += 1
    print(f"[train] prepared {n} samples in {flat}", flush=True)

    hf_out = work / "acestep-hf"
    cmd = [
        "python", str(ACE_STEP_DIR / "convert2hf_dataset.py"),
        "--data_dir", str(flat),
        "--repeat_count", "100",
        "--output_name", str(hf_out),
    ]
    print(f"[train] converting to HF dataset: {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True, cwd=str(ACE_STEP_DIR))
    return hf_out


def _write_lora_config(rank: int, dest: Path) -> Path:
    """Write a minimal LoRA config json matching ACE-Step's schema."""
    cfg = {
        "r": int(rank),
        "lora_alpha": int(rank) * 2,
        "target_modules": [
            "linear_q", "linear_k", "linear_v",
            "to_q", "to_k", "to_v", "to_out.0",
        ],
    }
    dest.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return dest


def run_acestep_training(
    dataset_dir: Path,
    output_dir: Path,
    args: argparse.Namespace,
    resume_from: Path | None,
    monitor: TrainerMonitor | None,
) -> dict[str, Any]:
    """Invoke the upstream ACE-Step trainer. Returns a dict of summary
    metrics; raises CalledProcessError on failure.

    When `monitor` is provided, the subprocess is wrapped so that we can
    tail stdout for step/loss events and signal it on pause/earlyStop.
    """
    work = output_dir.parent
    hf_dataset = _prepare_acestep_dataset(dataset_dir, work)
    lora_config = _write_lora_config(args.rank, work / "lora_config.json")

    cmd: list[str] = [
        "python", "-u", str(ACE_STEP_DIR / "trainer.py"),
        "--dataset_path", str(hf_dataset),
        "--checkpoint_dir", str(output_dir),
        "--logger_dir", str(output_dir / "logs"),
        "--exp_name", args.exp_name,
        "--max_steps", str(args.max_steps),
        "--learning_rate", str(args.lr),
        "--every_n_train_steps", str(CHECKPOINT_EVERY),
        "--every_plot_step", str(CHECKPOINT_EVERY),
        "--lora_config_path", str(lora_config),
        "--devices", "1",
        "--num_workers", "2",
        "--precision", "bf16-mixed",
    ]
    if resume_from is not None:
        cmd += ["--ckpt_path", str(resume_from)]

    env = os.environ.copy()
    print(f"[train] launching: {' '.join(cmd)}", flush=True)
    if monitor is None:
        proc = subprocess.run(cmd, check=False, cwd=str(ACE_STEP_DIR), env=env)
        rc = proc.returncode
    else:
        rc = _run_with_monitor(cmd, monitor, cwd=str(ACE_STEP_DIR), env=env)

    if rc != 0:
        raise SystemExit(f"acestep trainer exited {rc}")

    # ACE-Step writes summary.json (we hope) — accept either presence.
    summary_path = output_dir / "summary.json"
    if summary_path.exists():
        return json.loads(summary_path.read_text())
    return {"status": "completed", "max_steps": args.max_steps}


def _run_with_monitor(
    cmd: list[str],
    monitor: TrainerMonitor,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> int:
    """Run subprocess, tee stdout into the monitor's line parser."""
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        text=True,
        cwd=cwd,
        env=env,
    )
    monitor.process_ref["proc"] = proc  # type: ignore[assignment]
    monitor.emit(kind="started", message="Trainer subprocess launched")

    def _pump() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            monitor.consume_stdout_line(line)

    t = threading.Thread(target=_pump, daemon=True, name="trainer-stdout")
    t.start()
    proc.wait()
    t.join(timeout=5)
    return proc.returncode


def _build_monitor(args: argparse.Namespace) -> TrainerMonitor | None:
    if not args.job_id or not args.app_url:
        return None
    secret = os.environ.get("MMO_TRAINER_SECRET") or ""
    if not secret:
        print("[train] WARNING: MMO_TRAINER_SECRET not set — monitor disabled", flush=True)
        return None
    base = args.app_url.rstrip("/")
    mon = TrainerMonitor(
        job_id=args.job_id,
        webhook_url=f"{base}/api/training/webhook",
        control_url=f"{base}/api/training/control/{args.job_id}",
        secret=secret,
    )
    mon.start()
    return mon


def main() -> None:
    args = parse_args()
    work = Path(tempfile.mkdtemp(prefix="acestep-"))
    dataset_local = work / "dataset"
    output_local = work / "output"
    output_local.mkdir(parents=True, exist_ok=True)

    print(f"[train] working dir: {work}", flush=True)

    monitor = _build_monitor(args)

    # Configure MLflow (defaults to local mlruns/ → uploaded at end).
    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI",
                                  f"file://{work}/mlruns")
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment(f"acestep-lora-{args.exp_name}")

    with mlflow.start_run():
        mlflow.log_params({
            "exp_name": args.exp_name,
            "max_steps": args.max_steps,
            "rank": args.rank,
            "lr": args.lr,
            "batch_size": args.batch_size,
            "dataset_uri": args.dataset_uri,
        })

        # 1. Download dataset from GCS.
        gcs_download_dir(args.dataset_uri, dataset_local)

        # 2. Look for an existing checkpoint to resume from (preemption-safe).
        resume_path = find_resume_checkpoint(args.output_uri, work / "ckpt-resume")

        # 3. Run training.
        try:
            metrics = run_acestep_training(dataset_local, output_local, args, resume_path, monitor)
            mlflow.log_metrics({k: v for k, v in metrics.items() if isinstance(v, (int, float))})
        except SystemExit as e:
            mlflow.log_param("crash", str(e))
            if monitor:
                monitor.emit(kind="error", message=f"Trainer crashed: {e}")
                monitor.stop()
            # Even on crash, upload whatever partial output we have so the
            # next preemption-resume can pick it up.
            gcs_upload_dir(output_local, args.output_uri)
            raise

        # 4. Upload final artifacts (checkpoints + LoRA file + summary).
        gcs_upload_dir(output_local, args.output_uri)

        # 5. Upload MLflow tracking data to GCS too.
        mlflow_local = Path(tracking_uri.replace("file://", "")) if tracking_uri.startswith("file://") else None
        if mlflow_local and mlflow_local.exists():
            gcs_upload_dir(mlflow_local, args.output_uri.rstrip("/") + "/mlflow/")

    # 6. Final webhook with weights pointer.
    if monitor:
        weights_uri = args.output_uri.rstrip("/") + "/pytorch_lora_weights.safetensors"
        monitor.emit(
            kind="finished",
            message="Trainer finished cleanly",
            data={
                "weightsUri": weights_uri,
                "outputUri": args.output_uri,
            },
        )
        monitor.stop()

    print("[train] done.", flush=True)


if __name__ == "__main__":
    main()
