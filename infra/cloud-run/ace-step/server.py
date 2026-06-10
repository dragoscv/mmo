"""
MMO Cloud Run ACE-Step song-generation service (GPU).

POST /generate {
    "prompt":        "psytrance dark forest 138 bpm",
    "lyrics":        "" | "<lyric block>",
    "durationSec":   30,
    "inferStep":     60,
    "guidanceScale": 15,
    "schedulerType": "euler",
    "cfgType":       "apg",
    "omegaScale":    10,
    "seeds":         [12345] | null,
    "loraGs":        null | "gs://bucket/path/to/lora.ckpt",
    "loraWeight":    1.0,
    "output":        "gs://mmo-generated-prod/songs/<userId>/<assetId>/song.wav"
}
→ { ok, output, sampleRate, durationSec, model, device, sizeBytes }

POST /health → { ok, cuda, device, modelLoaded }

Auth: requires Google-signed ID token in Authorization: Bearer ...
(no_allow_unauthenticated; audience = service URL).

The web app calls this when the companion is offline (or when explicitly
routed by the user via the cloud-mix toggle). Output is uploaded to GCS
so the web side can stream it back to the user without holding a giant
multipart response open on Cloud Run.

Cost (May 2026, europe-west1):
  L4 GPU: ~$0.71/hr  →  $0.00020/s
  CPU/RAM:           ~$0.000050/s
  A 60s song @ infer_step=60 ≈ 40s GPU → ~$0.010 per song after warm.
  Cold start (first request): ~90s to download weights, ~$0.025 once.
"""

from __future__ import annotations

import gc
import os
import tempfile
import uuid
from urllib.parse import urlparse

from flask import Flask, jsonify, request
from google.cloud import storage  # type: ignore

app = Flask(__name__)
_gcs_client: storage.Client | None = None
_pipeline = None  # ACEStepPipeline singleton


# ─── helpers ───────────────────────────────────────────────────────

def gcs() -> storage.Client:
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = storage.Client()
    return _gcs_client


def parse_gs(uri: str) -> tuple[str, str]:
    if not uri.startswith("gs://"):
        raise ValueError(f"not a gs:// URI: {uri}")
    parsed = urlparse(uri)
    return parsed.netloc, parsed.path.lstrip("/")


def cuda_cleanup() -> None:
    """Free per-call activations. The pipeline singleton stays resident
    so subsequent warm requests don't reload the ~6 GB of weights."""
    try:
        import torch  # type: ignore
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def get_pipeline():
    """Lazy-construct the ACE-Step pipeline on the GPU. Cached for the
    lifetime of the gunicorn worker (Cloud Run warm instance)."""
    global _pipeline
    if _pipeline is not None:
        return _pipeline
    from acestep.pipeline_ace_step import ACEStepPipeline  # type: ignore

    _pipeline = ACEStepPipeline(
        checkpoint_dir=None,        # let HF cache resolve
        dtype="bfloat16",
        torch_compile=False,
        # Keep cpu_offload=False because we own the whole L4 (24 GB) per
        # instance; the perf hit isn't worth it here. (On the companion
        # we share VRAM with other engines and pay this same cost.)
        cpu_offload=False,
    )
    return _pipeline


# ─── routes ────────────────────────────────────────────────────────

@app.get("/health")
def health():
    info: dict = {"ok": True, "modelLoaded": _pipeline is not None}
    try:
        import torch  # type: ignore
        info["cuda"] = bool(torch.cuda.is_available())
        if torch.cuda.is_available():
            info["device"] = torch.cuda.get_device_name(0)
            info["vramGb"] = round(
                torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1,
            )
    except Exception as e:
        info["cuda"] = False
        info["error"] = str(e)
    return jsonify(info)


@app.post("/generate")
def generate():
    body = request.get_json(silent=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "prompt-required"}), 400
    output_uri = body.get("output") or ""
    if not output_uri.startswith("gs://"):
        return jsonify({"error": "output must be a gs:// URI"}), 400

    lyrics = body.get("lyrics") or ""
    duration = float(body.get("durationSec") or 30.0)
    if duration <= 0 or duration > 300:
        return jsonify({"error": "durationSec must be 0 < x ≤ 300"}), 400

    infer_step = int(body.get("inferStep") or 60)
    guidance_scale = float(body.get("guidanceScale") or 15.0)
    scheduler_type = body.get("schedulerType") or "euler"
    cfg_type = body.get("cfgType") or "apg"
    omega_scale = float(body.get("omegaScale") or 10.0)
    seeds = body.get("seeds")
    lora_weight = float(body.get("loraWeight") or 1.0)

    out_bucket, out_path = parse_gs(output_uri)

    with tempfile.TemporaryDirectory() as tmp:
        # If the caller passed a LoRA in GCS, pull it down first.
        lora_path = "none"
        lora_gs = body.get("loraGs")
        if lora_gs:
            lb, lp = parse_gs(lora_gs)
            lora_local = os.path.join(tmp, f"lora-{uuid.uuid4().hex}.ckpt")
            try:
                gcs().bucket(lb).blob(lp).download_to_filename(lora_local)
                lora_path = lora_local
            except Exception as e:
                return jsonify({"error": f"lora download failed: {e}"}), 500

        dst = os.path.join(tmp, f"out-{uuid.uuid4().hex}.wav")
        try:
            pipeline = get_pipeline()
            pipeline(
                format="wav",
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
                save_path=dst,
                batch_size=1,
            )
        except Exception as e:
            cuda_cleanup()
            return jsonify({"error": f"generation failed: {e}"}), 500
        finally:
            cuda_cleanup()

        # ACE-Step may resolve save_path to a directory containing the
        # WAV; pick the newest file if so.
        final = dst
        if os.path.isdir(dst):
            candidates = sorted(
                (os.path.join(dst, f) for f in os.listdir(dst)),
                key=lambda p: os.path.getmtime(p),
                reverse=True,
            )
            if candidates:
                final = candidates[0]
        if not os.path.isfile(final):
            return jsonify({"error": "pipeline produced no audio file"}), 500

        try:
            gcs().bucket(out_bucket).blob(out_path).upload_from_filename(
                final, content_type="audio/wav",
            )
        except Exception as e:
            return jsonify({"error": f"upload failed: {e}"}), 500

        try:
            import torch  # type: ignore
            device = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "unknown"

        return jsonify({
            "ok": True,
            "output": output_uri,
            "sampleRate": 48000,
            "durationSec": duration,
            "model": "ace-step-v1.5",
            "device": device,
            "sizeBytes": os.path.getsize(final),
        })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=False)
