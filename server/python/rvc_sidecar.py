"""RVC v2 voice-conversion sidecar.

Retrieval-based Voice Conversion: takes a vocal WAV (your sung input or
a stem-separated vocal track) and converts the timbre to a target voice
that was trained on 10-30 minutes of clean speech. MIT licensed.

Workflows powered:
  • C: "Replace vocals with my voice" — Demucs isolates vocals from a
    source song, RVC retargets timbre to a per-user model, the rest of
    the stems get re-mixed.

Implementation
──────────────
Supports two backends, picked by capability at startup:
  1. `rvc_python` — pip-installable wrapper around the RVC v2 inference
     graph. Requires Python 3.11 venv (broken on 3.12 due to old numpy
     dependency that needs distutils.msvccompiler).
  2. `applio` — git checkout of https://github.com/IAHispano/Applio.
     We shell out to its `core.py infer` CLI when the python package
     is missing.

Model artifacts live under:
  <userData>/voices/.rvc-models/<modelId>/
    ├── model.pth          (the trained RVC v2 generator)
    └── added_IVF*.index   (optional retrieval index for timbre quality)

Wire protocol
─────────────
  { id, kind: "rvc.health" }
  { id, kind: "rvc.list-models" }
  { id, kind: "rvc.convert",
    inputPath:  "<vocal.wav>",
    modelDir:   "<path-to-<modelId>>",
    outputPath: "<out.wav>",
    pitchSemitones: 0,        # transpose (12 = up an octave, -12 = down)
    indexRate: 0.66,          # 0..1, how strongly to lean on the retrieval index
    f0Method: "rmvpe",        # rmvpe | pm | harvest | crepe
    protect: 0.33,            # 0..0.5, protect voiceless consonants from pitch warps
    filterRadius: 3 }
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _sidecar import Sidecar, has_module  # noqa: E402


# ─── Capability probe ──────────────────────────────────────────────
# Try a few common package names. rvc_python (pip install rvc-python) is
# the easiest path but currently broken on Python 3.12. Applio (cloned
# next to the repo) is the fallback — we shell out to it.

RVC_VARIANT: str | None = None
for _name in ("rvc_python", "rvc", "applio"):
    if has_module(_name):
        RVC_VARIANT = _name
        break

APPLIO_DIR = os.environ.get("MMO_APPLIO_DIR")
if APPLIO_DIR and not Path(APPLIO_DIR).is_dir():
    APPLIO_DIR = None
APPLIO_CORE = Path(APPLIO_DIR) / "core.py" if APPLIO_DIR else None
APPLIO_AVAILABLE = bool(APPLIO_CORE and APPLIO_CORE.is_file())

INSTALLED = RVC_VARIANT is not None or APPLIO_AVAILABLE
CAPABILITIES: list[str] = []
if INSTALLED:
    CAPABILITIES.append("convert")
if RVC_VARIANT == "rvc_python":
    # Only the python package exposes training right now.
    CAPABILITIES.append("train")

EXTRA = {
    "installed": INSTALLED,
    "variant": RVC_VARIANT or ("applio-cli" if APPLIO_AVAILABLE else None),
    "applioDir": APPLIO_DIR,
    "installHint": (
        None
        if INSTALLED
        else (
            "Two install paths:\n"
            "  1) python -m venv .venvs/rvc --system-site-packages && "
            ".venvs/rvc/Scripts/python.exe -m pip install rvc-python  (requires Python 3.11)\n"
            "  2) git clone https://github.com/IAHispano/Applio   and set MMO_APPLIO_DIR=<path>"
        )
    ),
}


sc = Sidecar(
    engine_id="rvc",
    version="0.3",
    capabilities=CAPABILITIES,
    extra_hello=EXTRA,
)


# ─── Lazy singletons (python-package backend only) ─────────────────

# LRU=1: only the most-recently-used RVC model stays in VRAM. Each .pth is
# 50–200 MB plus the rmvpe/crepe pitch tracker (~80 MB), so an unbounded
# cache can swallow several GB across a user session and starve ACE-Step.
_rvc_model_cache: dict[str, object] = {}


def _free_old_rvc_models(keep_dir: str | None = None) -> None:
    """Evict every cached RVC model except `keep_dir`, freeing its GPU memory."""
    global _rvc_model_cache
    for key in list(_rvc_model_cache.keys()):
        if key == keep_dir:
            continue
        old = _rvc_model_cache.pop(key, None)
        del old
    try:
        import gc as _gc, torch as _torch  # type: ignore
        _gc.collect()
        if _torch.cuda.is_available():
            _torch.cuda.empty_cache()
    except Exception:
        pass


def _load_rvc_python_model(model_dir: str):
    """Cache one rvc_python.RVCInference per model directory (LRU=1)."""
    if model_dir in _rvc_model_cache:
        return _rvc_model_cache[model_dir]
    _free_old_rvc_models(keep_dir=model_dir)
    # rvc_python public API:
    #   from rvc_python.infer import RVCInference
    #   inf = RVCInference(model_path=..., index_path=..., device="cuda:0")
    #   inf.infer_file(input_path, output_path, f0_method=..., transpose=..., ...)
    from rvc_python.infer import RVCInference  # type: ignore

    pth = _pick_one(model_dir, suffixes=(".pth",))
    if not pth:
        raise RuntimeError(f"no .pth checkpoint under {model_dir}")
    idx = _pick_one(model_dir, suffixes=(".index",))
    try:
        import torch  # type: ignore
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    except ImportError:
        device = "cpu"
    inf = RVCInference(model_path=pth, index_path=idx, device=device)
    _rvc_model_cache[model_dir] = inf
    return inf


def _pick_one(dir_path: str, suffixes: tuple[str, ...]) -> str | None:
    try:
        for f in sorted(os.listdir(dir_path)):
            for s in suffixes:
                if f.lower().endswith(s):
                    return os.path.join(dir_path, f)
    except OSError:
        pass
    return None


# ─── Handlers ──────────────────────────────────────────────────────


@sc.handler("rvc.health")
def _health(_args: dict, _ctx) -> dict:
    info: dict = {
        "installed": INSTALLED,
        "variant": EXTRA["variant"],
        "applioDir": APPLIO_DIR,
    }
    if INSTALLED:
        try:
            import torch  # type: ignore

            info["cudaAvailable"] = bool(torch.cuda.is_available())
            if torch.cuda.is_available():
                info["device"] = torch.cuda.get_device_name(0)
        except Exception:
            info["cudaAvailable"] = False
    return info


@sc.handler("rvc.convert")
def _convert(args: dict, ctx) -> dict:
    if not INSTALLED:
        raise RuntimeError(
            "engine-missing: rvc — see installHint in /voice/engines"
        )

    input_path = args.get("inputPath")
    model_dir = args.get("modelDir")
    output_path = args.get("outputPath")
    if not input_path or not os.path.isfile(input_path):
        raise ValueError(f"inputPath not found: {input_path}")
    if not model_dir or not os.path.isdir(model_dir):
        raise ValueError(f"modelDir not found: {model_dir}")
    if not output_path:
        raise ValueError("outputPath required")

    pitch = int(args.get("pitchSemitones") or 0)
    index_rate = float(args.get("indexRate") or 0.66)
    f0_method = (args.get("f0Method") or "rmvpe").lower()
    protect = float(args.get("protect") or 0.33)
    filter_radius = int(args.get("filterRadius") or 3)
    rms_mix_rate = float(args.get("rmsMixRate") or 0.25)

    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    if RVC_VARIANT == "rvc_python":
        ctx.progress("loading", 0.1, "loading rvc-python model")
        inf = _load_rvc_python_model(model_dir)
        ctx.progress("converting", 0.4, f"f0={f0_method} pitch={pitch}")
        try:
            inf.infer_file(
                input_path=input_path,
                output_path=output_path,
                f0_method=f0_method,
                transpose=pitch,
                index_rate=index_rate,
                protect=protect,
                filter_radius=filter_radius,
                rms_mix_rate=rms_mix_rate,
            )
        finally:
            # Free per-call activation tensors so the next ACE-Step/Demucs
            # job on the same GPU starts from a clean VRAM baseline.
            try:
                import gc as _gc, torch as _torch  # type: ignore
                _gc.collect()
                if _torch.cuda.is_available():
                    _torch.cuda.empty_cache()
            except Exception:
                pass
        ctx.progress("converting", 1.0, "done")
        return _conversion_meta(output_path, model_dir, f0_method, pitch)

    # Applio CLI fallback.
    if APPLIO_AVAILABLE:
        pth = _pick_one(model_dir, suffixes=(".pth",)) or ""
        idx = _pick_one(model_dir, suffixes=(".index",)) or ""
        if not pth:
            raise RuntimeError(f"no .pth checkpoint under {model_dir}")
        ctx.progress("converting", 0.2, "shell-out to applio core.py infer")
        cmd = [
            sys.executable,
            str(APPLIO_CORE),
            "infer",
            "--input_path",
            input_path,
            "--output_path",
            output_path,
            "--pth_path",
            pth,
            "--index_path",
            idx,
            "--pitch",
            str(pitch),
            "--index_rate",
            str(index_rate),
            "--f0_method",
            f0_method,
            "--protect",
            str(protect),
            "--filter_radius",
            str(filter_radius),
        ]
        proc = subprocess.run(  # noqa: S603
            cmd,
            cwd=APPLIO_DIR,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"applio-failed (exit={proc.returncode}): {proc.stderr[-500:] or proc.stdout[-500:]}"
            )
        if not os.path.isfile(output_path):
            raise RuntimeError("applio reported success but no output file")
        ctx.progress("converting", 1.0, "done")
        return _conversion_meta(output_path, model_dir, f0_method, pitch)

    raise RuntimeError("engine-missing: rvc (no usable backend)")


def _conversion_meta(output_path: str, model_dir: str, f0_method: str, pitch: int) -> dict:
    """Resolve sample rate + duration without re-loading the full file."""
    try:
        import wave

        with wave.open(output_path, "rb") as wf:
            sr = wf.getframerate()
            duration = wf.getnframes() / float(sr)
    except Exception:  # noqa: BLE001
        # Some RVC paths emit FLAC; fall back to soundfile.
        try:
            import soundfile as sf  # type: ignore

            info = sf.info(output_path)
            sr = info.samplerate
            duration = info.duration
        except Exception:  # noqa: BLE001
            sr, duration = 0, 0.0

    try:
        import torch  # type: ignore

        device = (
            torch.cuda.get_device_name(0)
            if torch.cuda.is_available()
            else "cpu"
        )
    except Exception:
        device = "cpu"

    return {
        "audioPath": output_path,
        "sampleRate": sr,
        "durationSec": duration,
        "model": os.path.basename(model_dir.rstrip(os.sep + "/")),
        "f0Method": f0_method,
        "pitchSemitones": pitch,
        "device": device,
    }


@sc.handler("rvc.list-models")
def _list_models(args: dict, _ctx) -> dict:
    """Inventory the user's trained RVC models under a root directory.

    Each <root>/<modelId>/ must contain a single .pth (required) and may
    contain an .index file (optional but improves quality).
    """
    root = args.get("modelsRoot")
    if not root or not os.path.isdir(root):
        return {"models": []}

    out: list[dict] = []
    for name in sorted(os.listdir(root)):
        sub = os.path.join(root, name)
        if not os.path.isdir(sub):
            continue
        pth = _pick_one(sub, suffixes=(".pth",))
        if not pth:
            continue
        idx = _pick_one(sub, suffixes=(".index",))
        pth_size = os.path.getsize(pth)
        out.append({
            "id": name,
            "path": sub,
            "pth": pth,
            "index": idx,
            "sizeMB": round(pth_size / 1048576.0, 1),
        })
    return {"models": out, "modelsRoot": root}


@sc.handler("rvc.train")
def _train(_args: dict, _ctx) -> dict:
    # Training takes hours on a 3060 Ti and tens of GB of dataset prep —
    # better suited to the cloud LoRA flow (see infra/vertex/ace-step-lora).
    # We surface the same hint so callers know where to look.
    raise NotImplementedError(
        "rvc.train is not implemented in-process. "
        "Use Applio's GUI training, or our Vertex AI flow for ACE-Step LoRA "
        "(see app /settings/copilot → Training)."
    )


if __name__ == "__main__":
    sc.run()
