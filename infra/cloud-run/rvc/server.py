"""RVC voice conversion Cloud Run GPU service (scaffold).

API:
  GET  /health   → {ok, cuda, voicesLoaded}
  POST /convert  → {inputGs, voiceGs, outputGs, pitch?}
                   Currently returns 501 voice-storage-not-implemented;
                   the per-user voice-model GCS layer is the gating
                   dependency. The Cloud Run image + endpoint are live so
                   wiring the storage layer later is incremental.
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
        "service": "mmo-rvc",
        "device": _DEVICE,
        "cuda": cuda_ok,
        "cudaDevice": torch.cuda.get_device_name(0) if cuda_ok else None,
        "torch": torch.__version__,
        "implemented": False,
        "blockedOn": "per-user RVC voice-model GCS storage layer",
    })


@app.post("/convert")
def convert() -> Any:
    body = request.get_json(force=True, silent=True) or {}
    if not body.get("inputGs") or not body.get("voiceGs") or not body.get("outputGs"):
        return jsonify({"ok": False, "error": "inputGs, voiceGs, outputGs required"}), 400
    return jsonify({
        "ok": False,
        "error": "voice-storage-not-implemented",
        "details": "RVC cloud service is deployed but per-user voice-model storage in GCS is not yet wired. Track this in voice-stack roadmap.",
    }), 501


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)))
