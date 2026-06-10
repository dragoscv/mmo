"""ACE-Step 1.5 song-generation sidecar.

Open-source Suno alternative (MIT licensed, ~4GB VRAM, ~27x real-time
on RTX-class GPUs). Generates full songs with vocals from a text style
prompt + lyrics, supports LoRA fine-tuning.

Runs in its own venv (transformers==4.50 conflict). See engines.ts.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _sidecar import Sidecar, has_module  # noqa: E402


INSTALLED = has_module("acestep")
CAPABILITIES = ["generate", "lora"] if INSTALLED else []
EXTRA = {
    "installed": INSTALLED,
    "installHint": None if INSTALLED else "pip install git+https://github.com/ace-step/ACE-Step.git (use venv)",
    "modelSize": "2B",
}

sc = Sidecar(
    engine_id="ace-step",
    version="0.2",
    capabilities=CAPABILITIES,
    extra_hello=EXTRA,
)


# Lazily constructed singleton pipeline (loads ~6GB of weights).
_pipeline = None


def _get_pipeline(ctx, checkpoint_dir: str | None = None):
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    ctx.progress("loading", 0.0, "loading ACE-Step pipeline")
    from acestep.pipeline_ace_step import ACEStepPipeline  # type: ignore

    _pipeline = ACEStepPipeline(
        checkpoint_dir=checkpoint_dir,
        dtype="bfloat16",
        torch_compile=False,
        cpu_offload=False,
    )
    ctx.progress("loading", 1.0, "pipeline ready")
    return _pipeline


@sc.handler("acestep.health")
def _health(_args: dict, _ctx) -> dict:
    info: dict = {"installed": INSTALLED}
    if INSTALLED:
        try:
            import torch  # type: ignore

            info["cudaAvailable"] = bool(torch.cuda.is_available())
            if torch.cuda.is_available():
                info["device"] = torch.cuda.get_device_name(0)
        except Exception:
            info["cudaAvailable"] = False
    return info


@sc.handler("acestep.generate")
def _generate(args: dict, ctx) -> dict:
    if not INSTALLED:
        raise RuntimeError("engine-missing: acestep")

    prompt = args.get("prompt") or ""
    lyrics = args.get("lyrics") or ""
    duration = float(args.get("durationSec") or args.get("audioDuration") or 60.0)
    output_path = args.get("outputPath") or args.get("savePath")
    if not output_path:
        raise ValueError("outputPath required")
    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    infer_step = int(args.get("inferStep") or 60)
    guidance_scale = float(args.get("guidanceScale") or 15.0)
    scheduler_type = args.get("schedulerType") or "euler"
    cfg_type = args.get("cfgType") or "apg"
    omega_scale = float(args.get("omegaScale") or 10.0)
    seeds = args.get("seeds")
    lora_path = args.get("loraPath") or "none"
    lora_weight = float(args.get("loraWeight") or 1.0)
    # Multi-LoRA composition. When `loraPaths` is a non-empty list we bypass
    # the upstream pipeline's single-adapter `load_lora()` (which uses a
    # fixed adapter name) and call `load_lora_adapter` directly with unique
    # names so the adapters can be composed via PEFT's weight-and-activate.
    lora_paths_raw = args.get("loraPaths")
    lora_weights_raw = args.get("loraWeights")
    multi_lora_paths: list[str] = []
    multi_lora_weights: list[float] = []
    if isinstance(lora_paths_raw, list) and lora_paths_raw:
        multi_lora_paths = [str(p) for p in lora_paths_raw if p]
        if isinstance(lora_weights_raw, list) and len(lora_weights_raw) == len(multi_lora_paths):
            multi_lora_weights = [float(w) for w in lora_weights_raw]
        else:
            multi_lora_weights = [1.0] * len(multi_lora_paths)
    out_format = (args.get("format") or "wav").lower()

    pipeline = _get_pipeline(ctx, checkpoint_dir=args.get("checkpointDir"))

    # If multiple LoRAs were requested, stack them now. The pipeline call
    # below uses lora_name_or_path="none" so it doesn't try to unload them.
    if multi_lora_paths:
        _stack_loras(pipeline, multi_lora_paths, multi_lora_weights)
        lora_path = "none"
        lora_weight = 1.0

    ctx.progress("generating", 0.0, f"infer_step={infer_step} duration={duration}s")
    try:
        pipeline(
            format=out_format,
            audio_duration=duration,
            prompt=prompt,
            lyrics=lyrics,
            infer_step=infer_step,
            guidance_scale=guidance_scale,
            scheduler_type=scheduler_type,
            cfg_type=cfg_type,
            omega_scale=omega_scale,
            manual_seeds=seeds,
            lora_name_or_path=lora_path,
            lora_weight=lora_weight,
            save_path=output_path,
            batch_size=1,
        )
    finally:
        # ACE-Step keeps ~6GB of intermediate diffusion activations cached
        # across calls when cpu_offload is off. Free them so a follow-up
        # Demucs/RVC job on the same GPU doesn't OOM.
        try:
            import gc as _gc, torch as _torch  # type: ignore
            _gc.collect()
            if _torch.cuda.is_available():
                _torch.cuda.empty_cache()
        except Exception:
            pass
    ctx.progress("generating", 1.0, "done")

    # ACE-Step may treat save_path as a directory; resolve to newest file if so.
    final_path = output_path
    if os.path.isdir(output_path):
        files = sorted(
            (os.path.join(output_path, f) for f in os.listdir(output_path)),
            key=lambda p: os.path.getmtime(p),
            reverse=True,
        )
        if files:
            final_path = files[0]

    try:
        import torch  # type: ignore

        device = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
    except Exception:
        device = "unknown"

    return {
        "audioPath": final_path,
        "sampleRate": 48000,
        "durationSec": duration,
        "model": "ace-step-v1.5",
        "device": device,
        "prompt": prompt,
        "lyrics": lyrics,
    }


@sc.handler("acestep.loadLora")
def _load_lora(args: dict, _ctx) -> dict:
    if not INSTALLED:
        raise RuntimeError("engine-missing: acestep")
    path = args.get("path")
    if not path or not os.path.exists(path):
        raise ValueError(f"lora path not found: {path}")
    return {"path": os.path.abspath(path), "ok": True}


def _stack_loras(pipeline, paths: list[str], weights: list[float]) -> None:
    """Compose multiple LoRA adapters onto the ACE-Step transformer.

    Each path may be either a local directory (containing
    `pytorch_lora_weights.safetensors`) or a single .safetensors file.
    Adapter names are derived from the path stem so re-loading the same
    set is idempotent.
    """
    from acestep.pipeline_ace_step import set_weights_and_activate_adapters  # type: ignore

    # Drop any previously loaded adapters first to keep behaviour predictable.
    try:
        pipeline.ace_step_transformer.unload_lora()
    except Exception:
        pass
    pipeline.lora_path = "none"
    pipeline.lora_weight = 1.0

    names: list[str] = []
    for path, weight in zip(paths, weights):
        if not os.path.exists(path):
            print(f"[acestep] lora path missing, skipping: {path}", file=sys.stderr)
            continue
        weights_file = path
        if os.path.isdir(path):
            weights_file = os.path.join(path, "pytorch_lora_weights.safetensors")
            if not os.path.exists(weights_file):
                print(f"[acestep] no pytorch_lora_weights.safetensors in {path}", file=sys.stderr)
                continue
        stem = os.path.splitext(os.path.basename(path.rstrip("/\\")))[0]
        adapter_name = f"mmo_{stem[:32]}".replace("-", "_")
        try:
            pipeline.ace_step_transformer.load_lora_adapter(
                weights_file,
                adapter_name=adapter_name,
                with_alpha=True,
                prefix=None,
            )
            names.append(adapter_name)
        except Exception as e:  # noqa: BLE001
            print(f"[acestep] failed to load {weights_file}: {e}", file=sys.stderr)
    if names:
        # PEFT-style: enable all adapters at the requested weights simultaneously.
        set_weights_and_activate_adapters(
            pipeline.ace_step_transformer, names, weights[: len(names)],
        )
        print(f"[acestep] composed {len(names)} LoRA(s): {list(zip(names, weights))}", flush=True)


if __name__ == "__main__":
    sc.run()
