"""Conductor (Maestro brain) trainer.

SFT or DPO LoRA on top of a small instruct base model. Mirrors the
ACE-Step trainer's CLI surface so the shared `submit-training.py`
submitter works unchanged.

Expected dataset layout in `gs://.../dataset/`:

  SFT:
    train.jsonl  — {"messages":[{"role":"user","content":...},
                                {"role":"assistant","content":...}]}

  DPO:
    train.jsonl  — {"prompt": "...",
                    "chosen": "...",   # ideal assistant response
                    "rejected": "..."} # rejected response

The `--mode` flag controls which TRL trainer to use (sft|dpo). When the
dataset is empty (no thumbs-up sessions yet), the trainer exits with a
clear "no-data" message instead of producing garbage weights.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import mlflow  # type: ignore
from google.cloud import storage  # type: ignore

from monitor import TrainerMonitor  # type: ignore

DEFAULT_BASE_MODEL = os.environ.get("CONDUCTOR_BASE_MODEL", "Qwen/Qwen2.5-3B-Instruct")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--dataset-uri", required=True)
    p.add_argument("--output-uri", required=True)
    p.add_argument("--exp-name", required=True)
    p.add_argument("--max-steps", type=int, default=1500)
    p.add_argument("--rank", type=int, default=16)
    p.add_argument("--lr", type=float, default=2e-5)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--mode", default=os.environ.get("CONDUCTOR_MODE", "sft"),
                   choices=["sft", "dpo"])
    p.add_argument("--base-model", default=DEFAULT_BASE_MODEL)
    p.add_argument("--job-id", default=os.environ.get("MMO_TRAINING_JOB_ID"))
    p.add_argument("--app-url", default=os.environ.get("MMO_APP_URL"))
    return p.parse_args()


def parse_gs(uri: str) -> tuple[str, str]:
    if not uri.startswith("gs://"):
        raise SystemExit(f"Not a gs:// URI: {uri}")
    parsed = urlparse(uri)
    return parsed.netloc, parsed.path.lstrip("/")


def gcs_download_dir(uri: str, local: Path) -> int:
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
    return count


def gcs_upload_dir(local: Path, uri: str) -> int:
    bucket_name, prefix = parse_gs(uri)
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    count = 0
    for path in local.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(local).as_posix()
        bucket.blob(f"{prefix.rstrip('/')}/{rel}").upload_from_filename(str(path))
        count += 1
    return count


def _build_monitor(args: argparse.Namespace) -> TrainerMonitor | None:
    if not args.job_id or not args.app_url:
        return None
    secret = os.environ.get("MMO_TRAINER_SECRET") or ""
    if not secret:
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


def load_dataset(path: Path) -> list[dict[str, Any]]:
    f = path / "train.jsonl"
    if not f.exists():
        return []
    rows: list[dict[str, Any]] = []
    with f.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def train_sft(args: argparse.Namespace, dataset_rows: list[dict[str, Any]],
              output_dir: Path, monitor: TrainerMonitor | None) -> dict[str, Any]:
    from datasets import Dataset  # type: ignore
    from peft import LoraConfig  # type: ignore
    from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
    from trl import SFTConfig, SFTTrainer  # type: ignore

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    model = AutoModelForCausalLM.from_pretrained(args.base_model,
                                                  torch_dtype="auto",
                                                  device_map="auto")
    ds = Dataset.from_list(dataset_rows)

    cfg = SFTConfig(
        output_dir=str(output_dir),
        max_steps=args.max_steps,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch_size,
        save_steps=200,
        logging_steps=10,
        bf16=True,
        report_to=[],
    )
    lora = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, target_modules="all-linear",
                       task_type="CAUSAL_LM")
    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        peft_config=lora,
        args=cfg,
    )
    # TRL exposes a `log_callback` style hook via callbacks; we cheat and
    # patch the log method so step/loss flow into our monitor in real time.
    if monitor is not None:
        original_log = trainer.log
        def _log(logs: dict[str, Any]) -> None:
            original_log(logs)
            step = trainer.state.global_step
            loss = logs.get("loss")
            if isinstance(loss, (int, float)):
                monitor.emit(kind="step", step=int(step), loss=float(loss))
        trainer.log = _log  # type: ignore[assignment]

    trainer.train()
    trainer.save_model(str(output_dir))
    return {"final_step": trainer.state.global_step, "mode": "sft"}


def train_dpo(args: argparse.Namespace, dataset_rows: list[dict[str, Any]],
              output_dir: Path, monitor: TrainerMonitor | None) -> dict[str, Any]:
    from datasets import Dataset  # type: ignore
    from peft import LoraConfig  # type: ignore
    from transformers import AutoModelForCausalLM, AutoTokenizer  # type: ignore
    from trl import DPOConfig, DPOTrainer  # type: ignore

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    model = AutoModelForCausalLM.from_pretrained(args.base_model,
                                                  torch_dtype="auto",
                                                  device_map="auto")
    ds = Dataset.from_list(dataset_rows)
    cfg = DPOConfig(
        output_dir=str(output_dir),
        max_steps=args.max_steps,
        learning_rate=args.lr,
        per_device_train_batch_size=args.batch_size,
        save_steps=200,
        logging_steps=10,
        bf16=True,
        report_to=[],
    )
    lora = LoraConfig(r=args.rank, lora_alpha=args.rank * 2, target_modules="all-linear",
                       task_type="CAUSAL_LM")
    trainer = DPOTrainer(
        model=model,
        ref_model=None,  # TRL uses the LoRA-disabled base model as the ref.
        tokenizer=tokenizer,
        train_dataset=ds,
        peft_config=lora,
        args=cfg,
    )
    if monitor is not None:
        original_log = trainer.log
        def _log(logs: dict[str, Any]) -> None:
            original_log(logs)
            step = trainer.state.global_step
            loss = logs.get("loss")
            if isinstance(loss, (int, float)):
                monitor.emit(kind="step", step=int(step), loss=float(loss))
        trainer.log = _log  # type: ignore[assignment]

    trainer.train()
    trainer.save_model(str(output_dir))
    return {"final_step": trainer.state.global_step, "mode": "dpo"}


def main() -> None:
    args = parse_args()
    work = Path(tempfile.mkdtemp(prefix="conductor-"))
    dataset_local = work / "dataset"
    dataset_local.mkdir(parents=True, exist_ok=True)
    output_local = work / "output"
    output_local.mkdir(parents=True, exist_ok=True)

    monitor = _build_monitor(args)
    if monitor:
        monitor.emit(kind="started", message=f"Conductor {args.mode} trainer launched")

    tracking_uri = os.environ.get("MLFLOW_TRACKING_URI", f"file://{work}/mlruns")
    mlflow.set_tracking_uri(tracking_uri)
    mlflow.set_experiment(f"conductor-{args.mode}-{args.exp_name}")

    with mlflow.start_run():
        mlflow.log_params({
            "exp_name": args.exp_name,
            "mode": args.mode,
            "base_model": args.base_model,
            "max_steps": args.max_steps,
            "rank": args.rank,
            "lr": args.lr,
        })

        n = gcs_download_dir(args.dataset_uri, dataset_local)
        print(f"[conductor] downloaded {n} files", flush=True)

        rows = load_dataset(dataset_local)
        if not rows:
            msg = "no-data: dataset is empty; collect more thumbs-up sessions first"
            if monitor:
                monitor.emit(kind="error", message=msg)
                monitor.stop()
            raise SystemExit(msg)

        try:
            if args.mode == "sft":
                summary = train_sft(args, rows, output_local, monitor)
            else:
                summary = train_dpo(args, rows, output_local, monitor)
            mlflow.log_metrics({k: v for k, v in summary.items() if isinstance(v, (int, float))})
        except Exception as e:  # noqa: BLE001
            if monitor:
                monitor.emit(kind="error", message=str(e)[:500])
                monitor.stop()
            gcs_upload_dir(output_local, args.output_uri)
            raise

        gcs_upload_dir(output_local, args.output_uri)

    if monitor:
        weights_uri = args.output_uri.rstrip("/") + "/adapter_model.safetensors"
        monitor.emit(kind="finished",
                     message=f"Conductor {args.mode} finished",
                     weightsUri=weights_uri,
                     outputUri=args.output_uri)
        monitor.stop()

    print("[conductor] done.", flush=True)


if __name__ == "__main__":
    main()
