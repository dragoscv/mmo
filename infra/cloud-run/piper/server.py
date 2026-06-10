"""Piper TTS on Cloud Run CPU.

API:
  GET  /health      → {ok, voicesLoaded}
  POST /synthesize  → {voice, text, outputGs, sampleRate?, speed?}
                      Voice can be:
                        - "gs://bucket/path/voice.onnx" (with sibling .json config)
                        - bundled name (e.g. "en_US-amy-medium") downloaded on first use
                      response: {ok, output, sampleRate, durationSec, bytes}
"""
from __future__ import annotations

import io
import os
import tempfile
import time
import wave
from typing import Any

from flask import Flask, jsonify, request
from google.cloud import storage  # type: ignore

app = Flask(__name__)
_storage_client: storage.Client | None = None
_VOICES: dict[str, Any] = {}  # voice_id → PiperVoice
VOICES_DIR = os.environ.get("PIPER_VOICES_DIR", "/voices")
os.makedirs(VOICES_DIR, exist_ok=True)


def _gcs() -> storage.Client:
    global _storage_client
    if _storage_client is None:
        _storage_client = storage.Client()
    return _storage_client


def _split_gs(uri: str) -> tuple[str, str]:
    assert uri.startswith("gs://")
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


def _load_voice(voice_ref: str) -> Any:
    from piper import PiperVoice  # type: ignore
    if voice_ref in _VOICES:
        return _VOICES[voice_ref]

    if voice_ref.startswith("gs://"):
        # Download .onnx + sibling .json.
        local_onnx = os.path.join(VOICES_DIR, os.path.basename(voice_ref))
        if not os.path.exists(local_onnx):
            _download_gs(voice_ref, local_onnx)
            cfg_gs = voice_ref + ".json"
            cfg_local = local_onnx + ".json"
            if not os.path.exists(cfg_local):
                try:
                    _download_gs(cfg_gs, cfg_local)
                except Exception:
                    pass  # optional
        voice = PiperVoice.load(local_onnx)
    else:
        # Bundled voice name (e.g. en_US-amy-medium). Assume already
        # downloaded to /voices/<name>.onnx by image bake or sidecar setup.
        local_onnx = os.path.join(VOICES_DIR, voice_ref + ".onnx")
        voice = PiperVoice.load(local_onnx)
    _VOICES[voice_ref] = voice
    return voice


@app.get("/health")
def health() -> Any:
    return jsonify({
        "ok": True,
        "service": "mmo-piper",
        "voicesLoaded": list(_VOICES.keys()),
    })


@app.post("/synthesize")
def synthesize() -> Any:
    body = request.get_json(force=True, silent=True) or {}
    voice_ref = body.get("voice")
    text = body.get("text")
    output_gs = body.get("outputGs")
    speed = float(body.get("speed", 1.0))
    if not voice_ref or not text or not output_gs:
        return jsonify({"ok": False, "error": "voice, text, outputGs required"}), 400
    if not output_gs.startswith("gs://"):
        return jsonify({"ok": False, "error": "outputGs must be gs://"}), 400

    started = time.time()
    try:
        voice = _load_voice(voice_ref)
    except Exception as e:
        return jsonify({"ok": False, "error": f"voice load: {e}"}), 400

    with tempfile.TemporaryDirectory() as tmp:
        out_path = os.path.join(tmp, "out.wav")
        try:
            with wave.open(out_path, "wb") as wav:
                voice.synthesize(text, wav, length_scale=1.0 / max(speed, 0.1))
        except Exception as e:
            return jsonify({"ok": False, "error": f"synth: {e}"}), 500
        try:
            with wave.open(out_path, "rb") as wav:
                sr = wav.getframerate()
                frames = wav.getnframes()
                duration = frames / float(sr)
            size = _upload_gs(out_path, output_gs)
        except Exception as e:
            return jsonify({"ok": False, "error": f"upload: {e}"}), 500

    return jsonify({
        "ok": True,
        "output": output_gs,
        "sampleRate": sr,
        "durationSec": duration,
        "bytes": size,
        "elapsedSec": round(time.time() - started, 2),
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
