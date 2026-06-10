"""Demucs stem separation Cloud Run GPU service.

API:
  GET  /health         → {ok, cuda, modelLoaded}
  POST /separate       → {inputGs, outputGsPrefix, model?}
                          response: {ok, stems: {vocals,drums,bass,other}, sampleRate, durationSec, device, model}

Stems are written as gs://.../{vocals,drums,bass,other}.wav under outputGsPrefix.
"""
from __future__ import annotations

import gc
import io
import os
import tempfile
import time
from typing import Any

import torch
from flask import Flask, jsonify, request
from google.cloud import storage  # type: ignore

app = Flask(__name__)

_DEFAULT_MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs")
_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
_storage_client: storage.Client | None = None
_separator: Any = None
_separator_model: str | None = None


def _gcs() -> storage.Client:
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client()
    return _storage_client


def _split_gs(uri: str) -> tuple[str, str]:
    assert uri.startswith("gs://"), f"not a gs:// URI: {uri}"
    bucket, _, key = uri[5:].partition("/")
    return bucket, key


def _download_gs(uri: str, dest: str) -> None:
    bucket_name, key = _split_gs(uri)
    _gcs().bucket(bucket_name).blob(key).download_to_filename(dest)


def _upload_gs(src: str, uri: str) -> int:
    bucket_name, key = _split_gs(uri)
    blob = _gcs().bucket(bucket_name).blob(key)
    blob.upload_from_filename(src, content_type="audio/wav")
    return blob.size or 0


def _load(model_name: str):
    """Demucs Separator with eviction-on-model-change. Mirrors the
    companion `demucs_sidecar._load` to keep VRAM bounded to 1 model."""
    global _separator, _separator_model
    if _separator is not None and _separator_model == model_name:
        return _separator
    if _separator is not None:
        try:
            _separator = None
        finally:
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
    # Lazy import: only after CUDA env settled.
    from demucs.api import Separator  # type: ignore
    _separator = Separator(model=model_name, device=_DEVICE)
    _separator_model = model_name
    return _separator


def _cuda_cleanup() -> None:
    try:
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


@app.get("/health")
def health() -> Any:
    cuda_ok = torch.cuda.is_available()
    return jsonify({
        "ok": True,
        "service": "mmo-demucs",
        "device": _DEVICE,
        "cuda": cuda_ok,
        "cudaDevice": torch.cuda.get_device_name(0) if cuda_ok else None,
        "modelLoaded": _separator_model,
        "torch": torch.__version__,
    })


@app.post("/separate")
def separate() -> Any:
    body = request.get_json(force=True, silent=True) or {}
    input_gs: str | None = body.get("inputGs")
    output_prefix: str | None = body.get("outputGsPrefix")
    model_name: str = (body.get("model") or _DEFAULT_MODEL).strip()

    if not input_gs or not input_gs.startswith("gs://"):
        return jsonify({"ok": False, "error": "inputGs must be a gs:// URI"}), 400
    if not output_prefix or not output_prefix.startswith("gs://"):
        return jsonify({"ok": False, "error": "outputGsPrefix must be a gs:// URI"}), 400
    output_prefix = output_prefix.rstrip("/")

    started = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "input.wav")
        try:
            _download_gs(input_gs, src)
        except Exception as e:
            return jsonify({"ok": False, "error": f"download failed: {e}"}), 400

        try:
            sep = _load(model_name)
            # demucs.api.Separator.separate_audio_file returns (origin, stems_dict).
            _, stems = sep.separate_audio_file(src)
        except Exception as e:
            _cuda_cleanup()
            return jsonify({"ok": False, "error": f"demucs failed: {e}"}), 500

        try:
            import soundfile as sf  # type: ignore
            stem_uris: dict[str, str] = {}
            sample_rate: int | None = None
            duration_sec: float | None = None
            for name, tensor in stems.items():
                arr = tensor.detach().cpu().numpy().T  # (samples, channels)
                sr = int(getattr(sep, "samplerate", 44100))
                out_path = os.path.join(tmp, f"{name}.wav")
                sf.write(out_path, arr, sr)
                out_gs = f"{output_prefix}/{name}.wav"
                _upload_gs(out_path, out_gs)
                stem_uris[name] = out_gs
                sample_rate = sr
                duration_sec = arr.shape[0] / float(sr)
        finally:
            _cuda_cleanup()

    return jsonify({
        "ok": True,
        "stems": stem_uris,
        "sampleRate": sample_rate,
        "durationSec": duration_sec,
        "device": _DEVICE,
        "model": model_name,
        "elapsedSec": round(time.time() - started, 2),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
