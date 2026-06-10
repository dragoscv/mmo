"""
MMO Cloud Run CLAP audio-embedding service.

Used as a fallback when the user's companion is offline. The companion runs
the same model in `.venvs/clap/` so embeddings produced here are directly
comparable (same checkpoint = laion/larger_clap_music_and_speech, 512-d).

POST /embed
  {
    "input": "gs://bucket/path.wav"    # ← preferred
    "url":   "https://..."             # ← OR a public URL
  }
  → { "ok": true, "embedding": [512 floats], "model": "...", "dim": 512 }

Cost: ~$0.0005 per embedding on a 1 vCPU / 2 GB instance (CPU only).
Cold start ≈ 8s (weights are baked into the image).
"""

import io
import os
import tempfile
from urllib.parse import urlparse
from urllib.request import urlopen

import numpy as np  # type: ignore
import soundfile as sf  # type: ignore
import librosa  # type: ignore
import torch  # type: ignore
from flask import Flask, jsonify, request
from google.cloud import storage  # type: ignore
from transformers import ClapModel, ClapProcessor  # type: ignore

MODEL_ID = os.environ.get("CLAP_MODEL", "laion/larger_clap_music_and_speech")
TARGET_SR = 48000  # CLAP expects 48kHz mono

app = Flask(__name__)

print(f"[clap] loading {MODEL_ID}…", flush=True)
_model = ClapModel.from_pretrained(MODEL_ID).eval()
_processor = ClapProcessor.from_pretrained(MODEL_ID)
print("[clap] ready", flush=True)

_gcs: storage.Client | None = None


def gcs() -> storage.Client:
    global _gcs
    if _gcs is None:
        _gcs = storage.Client()
    return _gcs


def load_audio_mono_48k(path: str) -> np.ndarray:
    data, sr = sf.read(path, always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != TARGET_SR:
        data = librosa.resample(data.astype(np.float32), orig_sr=sr, target_sr=TARGET_SR)
    return data.astype(np.float32)


def embed_audio(samples: np.ndarray) -> list[float]:
    with torch.no_grad():
        inputs = _processor(audios=samples, sampling_rate=TARGET_SR, return_tensors="pt")
        embeds = _model.get_audio_features(**inputs)
        # L2-normalize so cosine similarity = dot product later in pgvector.
        embeds = torch.nn.functional.normalize(embeds, dim=-1)
        return embeds.squeeze(0).cpu().tolist()


@app.get("/healthz")
def healthz():
    return {"ok": True, "model": MODEL_ID, "dim": 512}


@app.post("/embed")
def embed():
    body = request.get_json(force=True, silent=True) or {}
    src_gs = body.get("input")
    src_url = body.get("url")

    with tempfile.TemporaryDirectory() as tmp:
        local = os.path.join(tmp, "in.wav")
        try:
            if src_gs:
                if not src_gs.startswith("gs://"):
                    return jsonify({"error": "input must be gs:// URI"}), 400
                parsed = urlparse(src_gs)
                gcs().bucket(parsed.netloc).blob(
                    parsed.path.lstrip("/"),
                ).download_to_filename(local)
            elif src_url:
                with urlopen(src_url, timeout=30) as r, open(local, "wb") as f:
                    f.write(r.read())
            elif request.files.get("file"):
                request.files["file"].save(local)
            else:
                return jsonify({"error": "provide input (gs://), url, or multipart file"}), 400
        except Exception as e:
            return jsonify({"error": f"fetch failed: {e}"}), 500

        try:
            samples = load_audio_mono_48k(local)
            if samples.size < TARGET_SR // 4:  # less than 0.25s of audio
                return jsonify({"error": "audio too short (< 250ms)"}), 400
            vec = embed_audio(samples)
        except Exception as e:
            return jsonify({"error": f"inference failed: {e}"}), 500

    return jsonify({
        "ok": True,
        "model": MODEL_ID,
        "dim": len(vec),
        "embedding": vec,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 8080)), debug=False)
