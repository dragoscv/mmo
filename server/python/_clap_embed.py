"""
CLAP embedding sidecar for the MMO companion.

Invoked by the companion's voice/router with:
    python _clap_embed.py --in <audio> --out <jobOut>/result.json

Produces a 512-dimension L2-normalized embedding using
laion/larger_clap_music_and_speech — the same checkpoint as the
Cloud Run fallback at infra/cloud-run/clap/, so embeddings produced
by either path are directly comparable in pgvector.

Venv: .venvs/clap (created by server/scripts/install-clap-venv.ps1).
Activate by setting PYTHON_BIN to the venv's python path; the
companion's engine-runner already does this via per-engine config.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np  # type: ignore
import soundfile as sf  # type: ignore
import librosa  # type: ignore
import torch  # type: ignore
from transformers import ClapModel, ClapProcessor  # type: ignore

MODEL_ID = "laion/larger_clap_music_and_speech"
TARGET_SR = 48000


def load_audio_mono_48k(path: Path) -> np.ndarray:
    data, sr = sf.read(str(path), always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != TARGET_SR:
        data = librosa.resample(data.astype(np.float32), orig_sr=sr, target_sr=TARGET_SR)
    return data.astype(np.float32)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--in", dest="input", required=True, help="Path to input audio file")
    p.add_argument("--out", dest="output", required=True, help="Path to write result JSON")
    p.add_argument("--device", default="cpu", help="'cpu' or 'cuda'")
    args = p.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not in_path.exists():
        out_path.write_text(json.dumps({"ok": False, "error": f"input not found: {in_path}"}))
        return 1

    print(f"[clap] loading {MODEL_ID} on {args.device}…", file=sys.stderr, flush=True)
    model = ClapModel.from_pretrained(MODEL_ID).eval()
    processor = ClapProcessor.from_pretrained(MODEL_ID)
    if args.device == "cuda" and torch.cuda.is_available():
        model = model.to("cuda")

    samples = load_audio_mono_48k(in_path)
    if samples.size < TARGET_SR // 4:
        out_path.write_text(json.dumps({"ok": False, "error": "audio too short (< 250ms)"}))
        return 1

    with torch.no_grad():
        inputs = processor(audios=samples, sampling_rate=TARGET_SR, return_tensors="pt")
        if args.device == "cuda" and torch.cuda.is_available():
            inputs = {k: v.to("cuda") for k, v in inputs.items()}
        embeds = model.get_audio_features(**inputs)
        embeds = torch.nn.functional.normalize(embeds, dim=-1)
        vec = embeds.squeeze(0).cpu().tolist()

    out_path.write_text(json.dumps({
        "ok": True,
        "model": MODEL_ID,
        "dim": len(vec),
        "embedding": vec,
    }))
    print(f"[clap] wrote {out_path}", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
