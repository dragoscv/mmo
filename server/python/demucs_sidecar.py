"""Demucs stem-separation sidecar.

Splits a stereo song into 4 stems (drums, bass, vocals, other) using
Demucs v4 (Hybrid Transformer Demucs). MIT licensed, pip-installable.

Used by:
  • Workflow A: split user's instrumental → drop on DAW tracks
  • Workflow B: split ACE-Step generated song → DAW tracks
  • Workflow C: isolate vocals from a source song before RVC conversion

Commands
────────
  demucs.separate {
    inputPath, outputDir,
    model?:    "htdemucs"|"htdemucs_ft"|"mdx_extra"   (default htdemucs)
    stems?:    "vocals"|"drums"|"bass"|"other"|null   (null = all 4)
    twoStems?: true                                   (combine into 2)
    int24?:    false
    mp3?:      false                                   (default WAV)
  }
  → { stems: { vocals, drums, bass, other }, sampleRate, model }

Install
───────
  pip install demucs
  (pulls in torch + torchaudio; we already have CUDA 12.9 wheels.)
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Allow `import _sidecar` regardless of CWD (companion spawns us
# with an absolute script path, not necessarily from python/).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _sidecar import Sidecar, has_module  # noqa: E402


# ─── Capability probe ──────────────────────────────────────────────

DEMUCS_AVAILABLE = has_module("demucs")

CAPABILITIES = ["separate"] if DEMUCS_AVAILABLE else []
EXTRA = {
    "installed": DEMUCS_AVAILABLE,
    "installHint": "pip install demucs" if not DEMUCS_AVAILABLE else None,
    "models": ["htdemucs", "htdemucs_ft", "mdx_extra"] if DEMUCS_AVAILABLE else [],
}

sc = Sidecar(
    engine_id="demucs",
    version="1.0",
    capabilities=CAPABILITIES,
    extra_hello=EXTRA,
)


# ─── Lazy singleton (demucs 4.0.1 has no demucs.api; use primitives) ──

_model = None
_model_name: str | None = None
_load_error: str | None = None
_device: str = "cpu"


def _load(model_name: str):
    """Load a Demucs bag-of-models. LRU=1: free the previous model's VRAM
    when switching, so two model variants never coexist on the GPU."""
    global _model, _model_name, _load_error, _device
    if _load_error and _model_name == model_name:
        raise RuntimeError(_load_error)
    if _model is not None and _model_name == model_name:
        return _model
    # Switching to a different model — free the previous one first.
    if _model is not None and _model_name != model_name:
        try:
            _model.to("cpu")
        except Exception:
            pass
        _model = None
        try:
            import gc as _gc, torch as _torch  # type: ignore
            _gc.collect()
            if _torch.cuda.is_available():
                _torch.cuda.empty_cache()
        except Exception:
            pass
    try:
        from demucs.pretrained import get_model  # type: ignore
        import torch  # type: ignore
        _device = "cuda" if torch.cuda.is_available() else "cpu"
        m = get_model(name=model_name)
        m.to(_device)
        m.eval()
        _model = m
        _model_name = model_name
        return _model
    except Exception as exc:  # noqa: BLE001
        _load_error = f"demucs-load-failed: {exc}"
        _model_name = model_name
        raise RuntimeError(_load_error) from exc


# ─── Handlers ──────────────────────────────────────────────────────

@sc.handler("demucs.health")
def _health(_args: dict, _ctx) -> dict:
    return {
        "installed": DEMUCS_AVAILABLE,
        "models": EXTRA["models"],
        "loadedModel": _model_name if _model else None,
    }


@sc.handler("demucs.separate")
def _separate(args: dict, ctx) -> dict:
    if not DEMUCS_AVAILABLE:
        raise RuntimeError("engine-missing: demucs (pip install demucs)")

    input_path = args["inputPath"]
    out_dir = args["outputDir"]
    model_name = args.get("model") or "htdemucs"
    stems_filter = args.get("stems")  # None = all 4
    two_stems = bool(args.get("twoStems") or False)
    mp3 = bool(args.get("mp3") or False)

    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"input-missing: {input_path}")
    Path(out_dir).mkdir(parents=True, exist_ok=True)

    ctx.progress("load", 0.05, f"loading {model_name}")
    model = _load(model_name)

    # Lazy heavy imports
    import torch  # type: ignore
    from demucs.apply import apply_model  # type: ignore
    from demucs.audio import AudioFile, save_audio  # type: ignore

    ctx.progress("read", 0.15, "decoding input")
    # AudioFile.read returns (channels, samples) tensor at the model's
    # native samplerate; we ask for stereo to match training distribution.
    wav = AudioFile(input_path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    wav = wav.to(_device)

    ctx.progress("separate", 0.25, "running separation")
    # apply_model wants a batch dim → unsqueeze(0); returns (B, S, C, T)
    try:
        with torch.no_grad():
            sources = apply_model(model, wav.unsqueeze(0), split=True, overlap=0.25, progress=False)[0]
    finally:
        # Even on a successful separation, demucs caches a few hundred MB
        # of attention activations. Free them so the next ACE-Step/RVC
        # request on the same GPU isn't squeezed.
        try:
            import gc as _gc
            _gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    sources = sources * ref.std() + ref.mean()

    # Map stem name → tensor using the model's declared source order.
    source_names = model.sources  # e.g. ["drums", "bass", "other", "vocals"]
    stems: dict[str, "torch.Tensor"] = {name: sources[i].cpu() for i, name in enumerate(source_names)}

    if two_stems:
        vocals = stems.get("vocals")
        if vocals is None:
            raise RuntimeError(f"model {model_name} has no vocals stem")
        accompaniment = torch.zeros_like(vocals)
        for n, t in stems.items():
            if n != "vocals":
                accompaniment = accompaniment + t
        stems = {"vocals": vocals, "accompaniment": accompaniment}

    if stems_filter:
        stems = {k: v for k, v in stems.items() if k == stems_filter}

    ctx.progress("write", 0.85, "writing stems")
    out_paths: dict[str, str] = {}
    base = Path(input_path).stem
    for name, tensor in stems.items():
        ext = "mp3" if mp3 else "wav"
        p = Path(out_dir) / f"{base}.{name}.{ext}"
        save_audio(tensor, str(p), samplerate=model.samplerate)
        out_paths[name] = str(p)

    ctx.progress("done", 1.0, "")
    return {
        "stems": out_paths,
        "sampleRate": int(model.samplerate),
        "model": model_name,
        "device": _device,
    }


if __name__ == "__main__":
    sc.run()
