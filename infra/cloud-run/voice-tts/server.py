"""Voice-cloning TTS Cloud Run GPU service (scaffold).

API:
  GET  /health      → {ok, cuda, enginesSupported}
  POST /synthesize  → {voiceGs, text, engine, outputGs, melody?}
                      Returns 501 until per-user voice-model GCS storage
                      is wired (companion stores voices on local disk only).
"""
from __future__ import annotations

import os
from typing import Any

import torch
from flask import Flask, jsonify, request

app = Flask(__name__)
_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"


@app.get("/health")
def health() -> Any:
    cuda_ok = torch.cuda.is_available()
    return jsonify({
        "ok": True,
        "service": "mmo-voice-tts",
        "device": _DEVICE,
        "cuda": cuda_ok,
        "cudaDevice": torch.cuda.get_device_name(0) if cuda_ok else None,
        "torch": torch.__version__,
        "enginesSupported": ["xtts", "f5", "fish"],
        "implemented": False,
        "blockedOn": "per-user voice-model GCS storage layer",
    })


@app.post("/synthesize")
def synthesize() -> Any:
    body = request.get_json(force=True, silent=True) or {}
    if not body.get("voiceGs") or not body.get("text") or not body.get("outputGs"):
        return jsonify({"ok": False, "error": "voiceGs, text, outputGs required"}), 400
    return jsonify({
        "ok": False,
        "error": "voice-storage-not-implemented",
        "details": "Voice-cloning cloud service is deployed; per-user voice reference storage in GCS is the next milestone.",
    }), 501


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
