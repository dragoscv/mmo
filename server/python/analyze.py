#!/usr/bin/env python3
"""
MMO Companion — audio analysis sidecar.

Spawned by the Electron companion as a child process. Reads JSON
commands from stdin (one per line) and writes JSON results to stdout
(one per line). Stays alive across multiple jobs to amortise model
load time.

Stems separation uses the SOTA `audio-separator` package (Ultimate
Vocal Remover models, ONNX runtime). Default model is BS-Roformer
which leads the MVSEP benchmark for vocal isolation as of 2025.

DSP analysis (BPM/key/beats/chords/energy) uses `librosa` (the
de-facto python audio DSP toolkit, works on every OS / Python combo
including Windows + Python 3.13 where Essentia has no wheels).
Loudness (LUFS / LRA / true-peak) uses `pyloudnorm` (BS.1770-4).
AcoustID fingerprinting uses pyacoustid + Chromaprint's `fpcalc`.

──────────────────────────────────────────────────────────────────────
Wire protocol (newline-delimited JSON, both directions)

→ Command (companion → analyzer):
   {
     "id":      "uuid-string",                  # job id
     "kind":    "ping" | "analyze",
     "path":    "C:/Music/track.mp3",           # required for analyze
     "trackId": 123,                            # required for analyze
     "outDir":  "C:/Users/.../stems/123",       # required when stems=True
     "options": {
        "stems":     true,                       # run source separation
        "dsp":       true,                       # bpm/key/loudness/beats
        "fingerprint": true,                     # chromaprint
        "structure": false,                      # all-in-one segments (heavy)
        "stemsModel": "model_bs_roformer_ep_317_sdr_12.9755"
     }
   }

← Event (analyzer → companion):
   {"id": "...", "kind": "progress", "stage": "load|stems|dsp|fp|done", "pct": 0..1, "msg": "..."}
   {"id": "...", "kind": "result", "ok": true,  "data": { ...analysis... }}
   {"id": "...", "kind": "result", "ok": false, "error": "..."}

──────────────────────────────────────────────────────────────────────
Install (one-time, on the user's machine):

  python -m venv .venv
  .venv\\Scripts\\Activate.ps1   # PowerShell (Windows)
  pip install --upgrade pip
  pip install audio-separator[cpu] librosa pyloudnorm pyacoustid soundfile numpy

For GPU acceleration on Windows w/ NVIDIA:
  pip install audio-separator[gpu]
For Apple Silicon:
  pip install audio-separator[cpu]      # auto-uses CoreML EP

The companion locates the python interpreter via $MMO_PYTHON env var
or falls back to `python` / `python3` on PATH. See server/README.md.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# ─── Lazy imports ────────────────────────────────────────────────────
# Heavy imports are deferred so the `ping` command stays cheap even
# when some optional deps are missing. Each capability sets a global
# flag so the companion can render an honest "what's available" UI.

_AVAILABLE = {
    "audio_separator": False,
    "librosa": False,
    "pyloudnorm": False,
    "soundfile": False,
    "pyacoustid": False,
    "numpy": False,
    "pedalboard": False,
    "essentia": False,
}


def _try_import_baseline() -> None:
    """Probe for the always-needed deps. Sets _AVAILABLE flags."""
    global np, sf
    try:
        import numpy  # noqa: F401
        import numpy as np  # type: ignore
        _AVAILABLE["numpy"] = True
    except Exception:
        np = None  # type: ignore
    try:
        import soundfile  # noqa: F401
        import soundfile as sf  # type: ignore
        _AVAILABLE["soundfile"] = True
    except Exception:
        sf = None  # type: ignore


def _try_import_librosa():
    try:
        import librosa  # type: ignore
        _AVAILABLE["librosa"] = True
        return librosa
    except Exception:
        return None


def _try_import_pyloudnorm():
    try:
        import pyloudnorm  # type: ignore
        _AVAILABLE["pyloudnorm"] = True
        return pyloudnorm
    except Exception:
        return None


def _try_import_essentia():
    """Probe for Essentia (industry-standard MIR toolkit, MTG/UPF).

    Used as the preferred Key extractor when available — its KeyExtractor
    algorithm (EDMA + Temperley + Krumhansl voting) is what Mixed-In-Key
    and Beatport use, and is empirically more accurate than any single
    profile-correlation we can build on top of librosa primitives.

    Optional. Essentia ships no Python 3.13 wheels on Windows as of
    2026-05; on those installs we silently fall back to the librosa
    Temperley path. To install: `pip install essentia` (Linux/macOS) or
    `pip install essentia-tensorflow` for GPU-accelerated models.
    """
    try:
        import essentia.standard  # type: ignore
        _AVAILABLE["essentia"] = True
        return essentia.standard
    except Exception:
        return None


def _resolve_bundled_fpcalc() -> str | None:
    """Locate the fpcalc binary the companion ships with electron-builder.

    Layout (electron-builder copies `assets/fpcalc/<arch-dir>/fpcalc(.exe)`
    into `process.resourcesPath/fpcalc/`). Python sidecar lives at
    `process.resourcesPath/python/analyze.py`, so the bundled binary is
    a sibling: `<this-file>/../../fpcalc/<arch-dir>/fpcalc(.exe)`.

    We also try a dev-tree fallback (`server/assets/fpcalc/...`) so
    `pnpm dev` works without a package step. Returns None when no
    bundled binary is found — caller should fall back to PATH lookup.
    """
    if sys.platform == "win32":
        sub, name = "win-x64", "fpcalc.exe"
    elif sys.platform == "darwin":
        sub, name = "mac-x64", "fpcalc"
    else:
        sub, name = "linux-x64", "fpcalc"

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        # Packaged: resourcesPath/fpcalc/<sub>/fpcalc(.exe) — sibling of python/
        os.path.join(here, "..", "fpcalc", sub, name),
        # Dev tree: server/assets/fpcalc/<sub>/fpcalc(.exe)
        os.path.join(here, "..", "assets", "fpcalc", sub, name),
        # Dev tree alt: cwd/server/assets/fpcalc/<sub>/...
        os.path.join(os.getcwd(), "server", "assets", "fpcalc", sub, name),
    ]
    for c in candidates:
        c = os.path.normpath(c)
        if os.path.isfile(c):
            return c
    return None


def _try_import_pyacoustid():
    # Point pyacoustid at the bundled fpcalc binary BEFORE importing it,
    # unless the user has explicitly overridden via FPCALC env var.
    # This is the difference between "fingerprint works out of the box"
    # and "user has to manually install Chromaprint and edit PATH".
    if not os.environ.get("FPCALC"):
        bundled = _resolve_bundled_fpcalc()
        if bundled:
            os.environ["FPCALC"] = bundled
    try:
        import acoustid  # type: ignore
        _AVAILABLE["pyacoustid"] = True
        return acoustid
    except Exception:
        return None


def _try_import_audio_separator():
    try:
        from audio_separator.separator import Separator  # type: ignore
        _AVAILABLE["audio_separator"] = True
        return Separator
    except Exception:
        return None


def _detect_gpu() -> dict[str, Any]:
    """Probe the host for GPU acceleration capability.

    Returned shape (consumed by the companion + web UI):
      {
        "hasNvidia":      bool,    # nvidia-smi works
        "gpuName":        str|None,# first GPU's product name
        "cudaRuntime":    str|None,# CUDA driver version reported by nvidia-smi
        "onnxPackage":    str|None,# onnxruntime | onnxruntime-gpu | onnxruntime-silicon
        "onnxProviders":  [str],   # providers ONNX is offering
        "onnxGpuActive":  bool,    # CUDA / DirectML / CoreML provider available
        "torchCuda":      bool,    # torch.cuda.is_available()
        "recommendation": str,     # "ready" | "install_onnx_gpu" | "install_cuda_runtime" | "no_gpu"
      }
    """
    info: dict[str, Any] = {
        "hasNvidia": False,
        "gpuName": None,
        "cudaRuntime": None,
        "onnxPackage": None,
        "onnxProviders": [],
        "onnxGpuActive": False,
        "torchCuda": False,
    }
    # nvidia-smi is the cheapest hardware probe (no Python deps, ~30 ms).
    try:
        import subprocess
        r = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=2,
        )
        if r.returncode == 0 and r.stdout.strip():
            line = r.stdout.strip().splitlines()[0]
            parts = [p.strip() for p in line.split(",")]
            info["hasNvidia"] = True
            info["gpuName"] = parts[0] if parts else None
            info["cudaRuntime"] = parts[1] if len(parts) > 1 else None
    except Exception:
        pass
    # ONNX runtime providers
    try:
        import onnxruntime as ort  # type: ignore
        try:
            providers = list(ort.get_available_providers())
        except Exception:
            providers = []
        info["onnxProviders"] = providers
        info["onnxGpuActive"] = any(
            p in providers
            for p in ("CUDAExecutionProvider", "DmlExecutionProvider", "CoreMLExecutionProvider")
        )
        try:
            from importlib.metadata import distributions
            for dist in distributions():
                name = (dist.metadata.get("Name") or "").lower()
                if name in ("onnxruntime-gpu", "onnxruntime-silicon", "onnxruntime"):
                    info["onnxPackage"] = name
                    break
        except Exception:
            pass
    except Exception:
        pass
    # PyTorch CUDA (audio-separator's Demucs path uses torch)
    try:
        import torch  # type: ignore
        info["torchCuda"] = bool(torch.cuda.is_available())
        if info["torchCuda"] and not info["gpuName"]:
            try:
                info["gpuName"] = torch.cuda.get_device_name(0)
            except Exception:
                pass
    except Exception:
        pass
    # Decide a recommendation the UI can act on.
    if info["onnxGpuActive"] or info["torchCuda"]:
        info["recommendation"] = "ready"
    elif info["hasNvidia"]:
        if info["onnxPackage"] == "onnxruntime-gpu":
            # GPU package installed but no provider exposed — means CUDA/cuDNN
            # runtime DLLs aren't on PATH (or wrong major version).
            info["recommendation"] = "install_cuda_runtime"
        else:
            info["recommendation"] = "install_onnx_gpu"
    else:
        info["recommendation"] = "no_gpu"
    return info


# ─── IO helpers ──────────────────────────────────────────────────────


def _send(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _progress(job_id: str, stage: str, pct: float, msg: str = "") -> None:
    _send({"id": job_id, "kind": "progress", "stage": stage,
           "pct": max(0.0, min(1.0, pct)), "msg": msg})


def _result_ok(job_id: str, data: dict[str, Any]) -> None:
    _send({"id": job_id, "kind": "result", "ok": True, "data": data})


def _result_err(job_id: str, error: str) -> None:
    _send({"id": job_id, "kind": "result", "ok": False, "error": error})


# ─── Stems separation ────────────────────────────────────────────────

# Model cache survives across jobs in the same process.
_separator: Any = None
_separator_model: str | None = None


def _get_separator(model_name: str):
    """Lazy-init the audio_separator.Separator with the requested model."""
    global _separator, _separator_model
    Separator = _try_import_audio_separator()
    if Separator is None:
        raise RuntimeError(
            "audio-separator not installed — run "
            "`pip install audio-separator[cpu]` (or [gpu] for CUDA).")
    if _separator is None or _separator_model != model_name:
        # Detect GPU capability so the sidecar logs make it obvious which
        # backend audio-separator will pick. The Separator class itself
        # auto-selects the best EP at load_model() time, but we bias its
        # log_level + record what we found so the UI can show "running on
        # NVIDIA GeForce RTX …" instead of leaving the user guessing.
        try:
            gpu = _detect_gpu()
            if gpu.get("onnxGpuActive") or gpu.get("torchCuda"):
                gpu_name = gpu.get("gpuName") or "GPU"
                print(f"[stems] GPU acceleration ACTIVE: {gpu_name} "
                      f"(onnx={gpu.get('onnxPackage')}, "
                      f"providers={gpu.get('onnxProviders')})",
                      file=sys.stderr, flush=True)
            elif gpu.get("hasNvidia"):
                print(f"[stems] NVIDIA {gpu.get('gpuName')} detected but "
                      f"GPU runtime not active "
                      f"(onnx={gpu.get('onnxPackage')}, "
                      f"recommendation={gpu.get('recommendation')}). "
                      "Run the 'Enable GPU' action in the analysis page.",
                      file=sys.stderr, flush=True)
        except Exception:
            pass
        _separator = Separator(
            output_format="WAV",
            normalization_threshold=0.95,
            log_level=30,  # logging.WARNING
            # Force a deterministic pass-count so the progress bar can
            # honestly say "pass N/M". Demucs default is shifts=2,
            # which doubles the tqdm bar count (htdemucs_ft becomes 8
            # instead of 4) AND doubles wall-clock for marginal
            # quality gain (~0.05 dB SDR). batch_size=4 lets the GPU
            # process several segments per forward pass — meaningful
            # speedup on RTX-class cards.
            demucs_params={
                "segment_size": "Default",
                "shifts": 1,
                "overlap": 0.25,
                "segments_enabled": True,
            },
            mdx_params={
                "hop_length": 1024,
                "segment_size": 256,
                "overlap": 0.25,
                "batch_size": 4,
                "enable_denoise": False,
            },
            mdxc_params={
                "segment_size": 256,
                "batch_size": 4,
                "overlap": 8,
            },
        )
        # audio-separator file conventions:
        #   - Demucs models:        `htdemucs_ft.yaml`, `htdemucs_6s.yaml`
        #   - BS / Mel-Roformer:    `*.ckpt`
        #   - UVR-MDX-NET:          `*.onnx`
        # Don't double-suffix when the caller already gave a full
        # filename (e.g. by copy-pasting from the audio-separator README).
        if model_name.endswith((".ckpt", ".onnx", ".pth", ".yaml", ".yml")):
            filename = model_name
        elif model_name.startswith("htdemucs") or model_name.startswith("hdemucs"):
            filename = f"{model_name}.yaml"
        else:
            filename = f"{model_name}.ckpt"
        _separator.load_model(model_filename=filename)
        _separator_model = model_name
    return _separator


def _separate_stems(path: str, out_dir: str, model_name: str, job_id: str | None = None) -> dict[str, str]:
    """Run source separation and return absolute paths to output stems.

    audio-separator outputs files named like
       `<input>_(Vocals)_<model>.wav`, `<input>_(Drums)_<model>.wav`
       `<input>_(Bass)_<model>.wav`,   `<input>_(Other)_<model>.wav`
    for 4-stem Demucs / Roformer models, or just (Vocals)+(Instrumental)
    for 2-stem Roformer-vocals models. We rename them to canonical
    `vocals.wav` / `drums.wav` / `bass.wav` / `other.wav` /
    `instrumental.wav` so the companion DB rows + web client don't
    need to know which model was used.
    """
    sep = _get_separator(model_name)
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    sep.output_dir = out_dir
    # audio-separator's internal logger emits "Processing chunk X/Y"
    # lines to stderr; we attach a logging handler to surface those as
    # progress events the companion can show to the user. Without this
    # the UI sits at "loading model" → "done" with no intermediate
    # signal during the heavy chunked inference (which is most of the
    # job's wall-clock time).
    if job_id is not None:
        try:
            import logging, re  # noqa: E401
            chunk_re = re.compile(r"chunk\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE)

            class _ProgressHandler(logging.Handler):
                def emit(self, record):  # type: ignore[override]
                    msg = record.getMessage()
                    m = chunk_re.search(msg)
                    if not m:
                        return
                    cur = int(m.group(1))
                    total = int(m.group(2))
                    if total <= 0:
                        return
                    # Stems span 0.60→0.95 of the overall job.
                    pct = 0.60 + 0.35 * (cur / total)
                    _progress(job_id, "stems", pct,
                              f"Separating chunk {cur}/{total}…")

            handler = _ProgressHandler()
            handler.setLevel(logging.INFO)
            logging.getLogger("audio_separator").addHandler(handler)
            logging.getLogger("audio_separator").setLevel(logging.INFO)
        except Exception:
            pass  # progress is nice-to-have, never block a real job

    # audio-separator drives ONNX/torch inference through tqdm, which
    # writes progress bars *directly to sys.stderr* (bypassing the
    # logging module entirely). The companion captures stderr and
    # tags every line as a debug log, so the user sees a single
    # "0/591" frame and then nothing for minutes. Wrap stderr so we
    # can detect tqdm-style updates ("N/M [HH:MM<HH:MM, ...it/s]")
    # and emit them as real progress events with an ETA.
    #
    # Multi-pass models: htdemucs_ft is an ENSEMBLE of 4 fine-tuned
    # Demucs checkpoints — audio-separator runs them sequentially and
    # emits a fresh tqdm bar (0→N) for each. Without accounting for
    # this the UI bar appears to "restart" 3 times near the end. We
    # detect a tqdm reset (cur drops below high-water mark) and
    # divide the 0.60→0.95 stems range across the discovered passes.
    stderr_wrapped = False
    # With shifts=1 (forced in _get_separator) we get exactly one
    # tqdm bar per model in the bag. htdemucs_ft is bag-of-4, so
    # expected_passes is 4. Other Demucs variants follow the same
    # rule (htdemucs = 1, htdemucs_6s = 1, htdemucs_ft = 4). For
    # non-Demucs models (Roformer, MDX-NET) we get 1 bar.
    name_l = model_name.lower()
    if "htdemucs_ft" in name_l:
        expected_passes = 4
    else:
        expected_passes = 1
    if job_id is not None:
        try:
            import re as _re, sys as _sys, time as _time
            tqdm_re = _re.compile(
                r"(\d+)\s*/\s*(\d+)\s*\[(\d{2}:\d{2})(?:<(\d{2}:\d{2}|\?))?",
            )
            _orig_stderr = _sys.stderr
            _last_emit = [0.0]
            _last_pct = [0.0]
            _pass_num = [1]
            _last_cur = [-1]
            _max_passes = [expected_passes]

            class _StderrTap:
                def __init__(self, base):
                    self._base = base
                def write(self, s):
                    try:
                        # Pass through to the real stderr so the parent
                        # still gets the raw tqdm bar in debug logs.
                        self._base.write(s)
                        m = tqdm_re.search(s or "")
                        if m:
                            cur = int(m.group(1))
                            total = int(m.group(2))
                            if total > 0:
                                # Detect a tqdm reset: cur dropped well
                                # below the previous value (new ensemble
                                # pass). Threshold of 50 avoids tripping
                                # on tqdm's occasional out-of-order
                                # flushes.
                                if cur + 50 < _last_cur[0]:
                                    _pass_num[0] += 1
                                    if _pass_num[0] > _max_passes[0]:
                                        _max_passes[0] = _pass_num[0]
                                _last_cur[0] = cur
                                # Compute pct across N passes: each
                                # pass occupies an equal slice of the
                                # 0.60→0.95 stems range.
                                passes = max(1, _max_passes[0])
                                pass_idx = max(0, _pass_num[0] - 1)
                                frac = (pass_idx + cur / total) / passes
                                # Cap at 0.94 so we never claim done
                                # until the actual file write completes
                                # (handled after sep.separate returns).
                                pct = 0.60 + 0.34 * min(frac, 1.0)
                                # STRICTLY MONOTONIC: never let pct
                                # decrease, even if our pass-count
                                # estimate had to grow mid-run. A
                                # backwards bar reads as "stalled" or
                                # "restarted" to the user and trips
                                # the watchdog's stall detection.
                                if pct < _last_pct[0]:
                                    pct = _last_pct[0]
                                # Throttle to ≥ 0.5 % motion or every 1 s
                                # so we don't spam the NDJSON pipe.
                                now = _time.time()
                                if (
                                    pct - _last_pct[0] >= 0.005
                                    or now - _last_emit[0] >= 1.0
                                    or cur == total
                                ):
                                    elapsed_s = m.group(3) or ""
                                    eta_s = m.group(4) or ""
                                    eta_part = (
                                        f", ETA {eta_s}" if eta_s and eta_s != "?" else ""
                                    )
                                    pass_part = (
                                        f" [pass {_pass_num[0]}/{passes}]"
                                        if passes > 1 else ""
                                    )
                                    _progress(
                                        job_id, "stems", pct,
                                        f"Separating {cur}/{total}{pass_part} ({elapsed_s}{eta_part})",
                                    )
                                    _last_emit[0] = now
                                    _last_pct[0] = pct
                    except Exception:
                        pass
                    return len(s) if isinstance(s, str) else 0
                def flush(self):
                    try:
                        self._base.flush()
                    except Exception:
                        pass
                def isatty(self):
                    return False
                def __getattr__(self, name):
                    return getattr(self._base, name)

            _sys.stderr = _StderrTap(_orig_stderr)
            stderr_wrapped = True
            _stderr_orig_ref = _orig_stderr
        except Exception:
            pass

    try:
        _progress(job_id, "stems", 0.60,
                  f"Separating with {model_name}"
                  + (f" ({expected_passes}-model ensemble)" if expected_passes > 1 else ""))
        output_files: list[str] = sep.separate(path)
        _progress(job_id, "stems", 0.95, "Writing stem files…")
    finally:
        if stderr_wrapped:
            try:
                import sys as _sys
                _sys.stderr = _stderr_orig_ref  # type: ignore[name-defined]
            except Exception:
                pass
    # Map UVR's stem names → our canonical names.
    canonical_map = {
        "vocals": "vocals.wav",
        "instrumental": "instrumental.wav",
        "drums": "drums.wav",
        "bass": "bass.wav",
        "other": "other.wav",
        "guitar": "guitar.wav",
        "piano": "piano.wav",
    }
    result: dict[str, str] = {}
    for f in output_files:
        full = os.path.join(out_dir, f) if not os.path.isabs(f) else f
        lower = os.path.basename(full).lower()
        for stem_key, canon in canonical_map.items():
            if f"({stem_key})" in lower or lower.startswith(stem_key + "."):
                target = os.path.join(out_dir, canon)
                # Avoid a self-rename failing if it already happens to
                # be the canonical name.
                if os.path.normcase(full) == os.path.normcase(target):
                    result[stem_key] = target
                    break
                # The source can be missing if a previous (interrupted) pass
                # already moved it, or demucs reported a path it didn't write.
                # Don't let one missing stem crash the whole job — prefer an
                # already-canonical file if present, else skip this stem.
                if not os.path.exists(full):
                    if os.path.exists(target):
                        result[stem_key] = target
                    break
                if os.path.exists(target):
                    os.remove(target)
                os.replace(full, target)  # atomic; tolerates existing target
                result[stem_key] = target
                break
    return result


# ─── DSP analysis (BPM, key, loudness, beats, chords) ────────────────


def _dsp_analyze(
    path: str,
    progress: "callable | None" = None,  # type: ignore[name-defined]
) -> dict[str, Any]:
    """Run librosa (BPM/key/beats/chords/energy) + pyloudnorm (LUFS).

    librosa is the de-facto SOTA python audio DSP toolkit (2025) and
    works on all OS / Python combos. Where Essentia would be slightly
    more accurate (multifeature beat tracker, EDMA key profile), we
    use the equivalent librosa primitives:

      • BPM:    librosa.beat.beat_track + onset envelope (PLP fallback)
      • Key:    Krumhansl–Schmuckler chromagram correlation (24 profiles)
      • Beats:  beat frame indices → seconds
      • Chords: librosa.feature.chroma_cqt + per-frame template match
      • LUFS:   pyloudnorm.Meter (BS.1770-4)
      • LRA:    pyloudnorm.normalize.loudness_range when available,
                else manual loudness-range over short-term blocks
      • TruePk: pyloudnorm `peak`-style 4× oversampled detector when
                available, else sample-peak fallback.
    """
    librosa = _try_import_librosa()
    if librosa is None:
        raise RuntimeError("librosa not installed — `pip install librosa`.")
    if not _AVAILABLE["soundfile"]:
        raise RuntimeError("soundfile not installed — `pip install soundfile`.")
    pln = _try_import_pyloudnorm()

    import numpy as _np  # type: ignore

    out: dict[str, Any] = {}
    sr_target = 22050  # librosa default; halves CPU vs 44.1k for DSP.

    def _step(pct: float, msg: str) -> None:
        if progress is not None:
            try: progress(pct, msg)
            except Exception: pass

    # ── Loudness (LUFS, true peak, LRA) ──────────────────────────────
    _step(0.07, "Loudness (LUFS)…")
    if pln is not None:
        try:
            data, sr = sf.read(path, always_2d=False)  # type: ignore
            # pyloudnorm needs ≥ block_size (default 0.4s) of audio; skip
            # absurdly short files (test stubs, single-shot one-shots).
            min_samples = int(0.5 * sr)
            n_samples = len(data) if data.ndim == 1 else data.shape[0]
            if n_samples < min_samples:
                out["_loudness_error"] = (
                    f"audio too short for LUFS ({n_samples / sr:.2f}s < 0.5s)"
                )
            else:
                meter = pln.Meter(sr)
                out["loudnessLufs"] = float(meter.integrated_loudness(data))
            try:
                out["loudnessRangeLu"] = float(pln.normalize.loudness_range(data, sr))  # type: ignore[attr-defined]
            except Exception:
                # Manual fallback: 75% percentile − 10% percentile of
                # short-term loudness over 3 s windows (close to EBU R128 LRA).
                try:
                    flat = data if data.ndim == 1 else data.mean(axis=1)
                    block = sr * 3
                    if len(flat) > block:
                        st = []
                        for i in range(0, len(flat) - block, block // 2):
                            st.append(meter.integrated_loudness(flat[i:i + block]))
                        st = [s for s in st if _np.isfinite(s)]
                        if len(st) >= 4:
                            arr = _np.array(st)
                            out["loudnessRangeLu"] = float(
                                _np.percentile(arr, 95) - _np.percentile(arr, 10)
                            )
                except Exception:
                    pass
            try:
                # True peak per BS.1770-4: oversample 4× with a polyphase
                # low-pass FIR, then take the max abs sample. The naive
                # implementation oversamples the entire file (~16 MB
                # per channel-minute at 44.1k → 96 MB for a 6 min
                # stereo track, plus FIR convolution → 8\u201320 s on CPU).
                #
                # Optimisation: intersample peaks only meaningfully
                # exceed sample peaks when the signal is hot (within
                # ~1 dB of full scale). For everything quieter we
                # report the sample peak directly \u2014 the worst-case
                # additional headroom from intersample peaks on a
                # below the practical threshold of any limiter setting.
                from scipy.signal import resample_poly  # type: ignore
                sample_peak = float(_np.max(_np.abs(data))) if data.size else 0.0
                if sample_peak > 0.891:  # ~ -1 dBFS — only oversample hot signals
                    if data.ndim == 1:
                        up = resample_poly(data, 4, 1)
                        peak = float(_np.max(_np.abs(up))) if up.size else 0.0
                    else:
                        # Per-channel oversample, take worst-case across channels.
                        peaks = []
                        for ch in range(data.shape[1]):
                            up = resample_poly(data[:, ch], 4, 1)
                            peaks.append(float(_np.max(_np.abs(up))) if up.size else 0.0)
                        peak = max(peaks) if peaks else 0.0
                else:
                    peak = sample_peak
                out["loudnessTruePeakDbfs"] = (
                    20.0 * float(_np.log10(peak)) if peak > 1e-8 else -120.0
                )
            except Exception as e:
                out["_truepeak_error"] = str(e)
        except Exception as e:
            out["_loudness_error"] = str(e)

    # ── Single-load mono signal for the rest of the pipeline ─────────
    _step(0.15, "Decoding audio…")
    try:
        # Cap at 8 minutes — enough for stable BPM/key/loudness/chords
        # on any DJ-relevant track, but bounds analysis time on long
        # mixes/sets that the user might have in their library. Tracks
        # shorter than 8 min are loaded entirely.
        y, sr = librosa.load(path, sr=sr_target, mono=True, duration=480.0)
    except Exception as e:
        out["_load_error"] = str(e)
        return out

    # ── Rhythm: BPM + beats + downbeats ──────────────────────────────
    _step(0.20, "Beat tracking…")
    try:
        # Tighter prior (60..200) reduces octave errors on EDM tracks.
        tempo, beat_frames = librosa.beat.beat_track(
            y=y, sr=sr, units="frames", start_bpm=120, tightness=120,
        )
        bpm = float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo)
        # Octave correction: prefer 60–180 BPM range.
        while bpm > 180.0:
            bpm /= 2.0
        while bpm < 60.0:
            bpm *= 2.0
        out["bpm"] = bpm
        # Cross-check with librosa.feature.tempo (newer API, uses an
        # autocorrelation aggregator across the onset envelope). When
        # the two estimators disagree by >10% we lower confidence so
        # the UI can flag the track for manual review. Cheap (~50ms).
        try:
            tempo2 = librosa.feature.tempo(y=y, sr=sr, aggregate=None)
            tempo2_med = float(_np.median(tempo2)) if hasattr(tempo2, "__len__") else float(tempo2)
            # Fold tempo2 into the 60–180 range too for a fair comparison.
            while tempo2_med > 180.0:
                tempo2_med /= 2.0
            while tempo2_med < 60.0:
                tempo2_med *= 2.0
            disagreement = abs(bpm - tempo2_med) / max(bpm, 1.0)
            out["bpmCrossCheck"] = tempo2_med
            out["bpmDisagreement"] = float(disagreement)
        except Exception:
            pass
        # Confidence proxy: ratio of consistent inter-beat intervals.
        beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
        if len(beat_times) >= 4:
            ibi = _np.diff(beat_times)
            consistency = 1.0 - float(_np.std(ibi) / (_np.mean(ibi) + 1e-6))
            out["bpmConfidence"] = max(0.0, min(1.0, consistency))
            # Penalise confidence when the two estimators disagree.
            if "bpmDisagreement" in out and out["bpmDisagreement"] > 0.10:
                out["bpmConfidence"] = float(out["bpmConfidence"]) * 0.5
        else:
            out["bpmConfidence"] = 0.0
        out["beats"] = [float(t) for t in beat_times]
        # Cheap 4/4 downbeat heuristic — same as the Essentia path.
        if len(beat_times) >= 4:
            out["downbeats"] = beat_times[::4]
    except Exception as e:
        out["_rhythm_error"] = str(e)

    # ── Tonality: Essentia KeyExtractor (preferred) → Temperley fallback ─
    _step(0.27, "Key estimation…")
    chroma_for_chords = None
    essentia_std = _try_import_essentia()
    used_essentia = False
    if essentia_std is not None:
        try:
            # Essentia's KeyExtractor: industry-standard MIR pipeline used
            # by Mixed-In-Key + Beatport. Loads its own audio (mono, 44.1k)
            # to avoid resampling-quality issues from our 22050 working
            # rate. Profile "edma" is tuned for electronic dance music; we
            # also run "temperley" for cross-check, picking whichever
            # reports the higher confidence.
            best_root: str | None = None
            best_scale: str | None = None
            best_strength = -1.0
            for profile in ("edma", "temperley"):
                try:
                    audio = essentia_std.MonoLoader(filename=path, sampleRate=44100)()  # type: ignore[attr-defined]
                    extractor = essentia_std.KeyExtractor(profileType=profile)  # type: ignore[attr-defined]
                    root, scale, strength = extractor(audio)
                    s = float(strength)
                    if s > best_strength:
                        best_root, best_scale, best_strength = str(root), str(scale), s
                except Exception:
                    continue
            if best_root is not None and best_scale is not None and best_strength > 0:
                # Normalise root spelling to the C/C#/.../B alphabet our
                # _to_camelot helper expects (essentia returns sharps).
                out["keyMusical"] = f"{best_root} {best_scale}"
                out["keyConfidence"] = max(0.0, min(1.0, best_strength))
                out["keyCamelot"] = _to_camelot(best_root, best_scale)
                out["keyMethod"] = "essentia"
                used_essentia = True
        except Exception as e:
            out["_essentia_key_error"] = str(e)

    # ── Tonality fallback: Temperley/K-S blended key estimation ─────
    # Used when Essentia is unavailable (Windows + Python 3.13 has no
    # wheels) or when Essentia errored on this specific file.
    if not used_essentia:
        # We use the Temperley 1999 profile (better empirical fit than the
        # original 1990 Krumhansl probe-tone data, especially for popular
        # music) on a *harmonic-only* chromagram (HPSS removes the
        # percussive noise floor). HPCP-style normalization keeps loud
        # tracks from biasing the correlation.
        #
        # Performance note: tonal centre is stable across a song, so we
        # analyse only a representative 90-second window from the middle
        # of the track instead of the full file. This is ~6x faster on
        # long sets without measurable accuracy loss. We also use
        # chroma_stft (FFT-based) instead of chroma_cqt — ~10x faster
        # for triad-template correlation, where CQT's extra log-spaced
        # precision doesn't change the winning key. The default HPSS
        # margin (1.0) is enough; margin=4 invokes very wide median
        # filters that can take minutes on long tracks.
        try:
            win_sec = 90.0
            win = int(win_sec * sr)
            if len(y) > win:
                start = (len(y) - win) // 2  # middle of the track
                y_for_key = y[start:start + win]
            else:
                y_for_key = y
            _step(0.28, "Key: HPSS (harmonic isolation)…")
            y_harm = librosa.effects.harmonic(y_for_key)  # default margin=1.0
            _step(0.30, "Key: chromagram…")
            chroma = librosa.feature.chroma_stft(y=y_harm, sr=sr, hop_length=2048)
            _step(0.31, "Key: profile correlation…")
            chroma_mean = chroma.mean(axis=1)
            # Normalize to unit sum so the correlation isn't dominated by
            # absolute energy (low-pass / loud sections).
            s = chroma_mean.sum()
            if s > 1e-8:
                chroma_mean = chroma_mean / s
            # Temperley 1999 profiles (better than Krumhansl 1990 across
            # genres; especially better on Romantic + electronic music).
            major_p = _np.array([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0])
            minor_p = _np.array([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0])
            notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
            scores = []
            for shift in range(12):
                mp = _np.roll(major_p, shift)
                mn = _np.roll(minor_p, shift)
                scores.append(("major", shift, float(_np.corrcoef(chroma_mean, mp)[0, 1])))
                scores.append(("minor", shift, float(_np.corrcoef(chroma_mean, mn)[0, 1])))
            scores.sort(key=lambda s: s[2], reverse=True)
            scale, root, conf = scores[0]
            out["keyMusical"] = f"{notes[root]} {scale}"
            out["keyConfidence"] = max(0.0, min(1.0, conf))
            # Camelot wheel mapping for DJ workflows (e.g. "8B" = C major,
            # "5A" = C minor). Stored alongside the musical key — clients
            # can pick whichever they prefer.
            out["keyCamelot"] = _to_camelot(notes[root], scale)
            out["keyMethod"] = "temperley_librosa"
        except Exception as e:
            out["_key_error"] = str(e)

    # ── Energy: RMS + spectral flux + onset density (Beatport-ish) ──
    _step(0.33, "Energy + spectral flux…")
    # Beatport's energy estimate is closer to "perceived intensity" than
    # raw RMS — a quiet but busy drum-and-bass track should score higher
    # than a loud-but-static drone. We blend three normalized features:
    #   • RMS in dB     → loudness contribution
    #   • spectral flux → how much spectral content changes per frame
    #                     (proxy for "punchiness")
    #   • onset density → events per second (proxy for "busy-ness")
    try:
        rms = float(_np.sqrt(_np.mean(y ** 2)))
        # Loudness component: -40 dB → 0, 0 dB → 1, clipped.
        if rms > 0:
            db = 20.0 * float(_np.log10(rms))
            loud_norm = max(0.0, min(1.0, (db + 40.0) / 40.0))
        else:
            loud_norm = 0.0
        # Spectral flux: mean L2 distance between adjacent magnitude
        # spectra (positive part — onset-like changes only).
        flux = 0.0
        try:
            S = _np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
            diff = _np.diff(S, axis=1)
            pos = _np.maximum(diff, 0.0)
            flux = float(_np.mean(pos))
        except Exception:
            pass
        flux_norm = max(0.0, min(1.0, flux / 0.05))  # 0.05 ≈ busy track
        # Onset density: librosa.onset.onset_detect returns frame indices.
        onset_norm = 0.0
        try:
            onsets = librosa.onset.onset_detect(y=y, sr=sr, units="time")
            duration = max(1.0, len(y) / sr)
            density = len(onsets) / duration  # onsets per second
            onset_norm = max(0.0, min(1.0, density / 6.0))  # 6/s ≈ frantic
        except Exception:
            pass
        # Weighted blend (loudness dominant; flux/onset add discrimination).
        score = 0.5 * loud_norm + 0.3 * flux_norm + 0.2 * onset_norm
        # 0..1 → 1..10 (clamped).
        out["energy"] = max(1, min(10, int(round(1 + score * 9))))
    except Exception as e:
        out["_energy_error"] = str(e)

    # ── Chord progression (template-match per beat, smoothed) ───────
    _step(0.39, "Chord progression…")
    # Pipeline:
    #   1. Harmonic-only signal (HPSS) → chroma_cens (energy-normalized
    #      chroma — robust to dynamics, see Müller & Ewert 2011).
    #   2. Beat-sync the chromagram (median per beat).
    #   3. Cosine similarity vs 24 maj/min triad templates per beat.
    #   4. Mode (=majority) filter over a 3-beat window — collapses
    #      single-beat flickers caused by bass-line passing tones,
    #      drum hits, etc. Without this the segments list explodes
    #      with 1-beat fragments that are visually + harmonically
    #      meaningless to the user.
    #   5. Run-length-compress identical labels into segments.
    _step(0.41, "Chords: chromagram…")
    try:
        if "beat_frames" in locals() and len(beat_frames) >= 2:
            # No second HPSS pass: the previous version recomputed
            # `librosa.effects.harmonic(y)` on the FULL track here,
            # which on a 5–6 min file alone takes 60–120 s and was the
            # #1 cause of the "chords stuck for minutes" stall. CENS
            # (chroma energy normalised statistics, Müller & Ewert
            # 2011) was specifically designed to be robust to
            # transients and percussive noise via its mean+median
            # filtering and quantization steps — so we get good chord
            # accuracy directly from the raw signal at a fraction of
            # the cost. Hop 2048 keeps the frame count tractable.
            chroma_full = librosa.feature.chroma_cens(
                y=y, sr=sr, hop_length=2048,
            )
            _step(0.43, "Chords: beat-sync…")
            beat_chroma = librosa.util.sync(
                chroma_full, beat_frames, aggregate=_np.median,
            )
            notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
            # Triad templates (root, third, fifth).
            templates: list[Any] = []
            labels: list[str] = []
            for r in range(12):
                maj = _np.zeros(12); maj[r] = 1; maj[(r + 4) % 12] = 1; maj[(r + 7) % 12] = 1
                templates.append(maj); labels.append(f"{notes[r]}")
                mn = _np.zeros(12); mn[r] = 1; mn[(r + 3) % 12] = 1; mn[(r + 7) % 12] = 1
                templates.append(mn); labels.append(f"{notes[r]}m")
            T = _np.stack(templates, axis=1)  # (12, 24)
            norms_T = _np.linalg.norm(T, axis=0) + 1e-8
            chord_seq: list[str] = []
            beat_times_local = librosa.frames_to_time(beat_frames, sr=sr)
            # `librosa.util.sync` may emit one extra column for the tail
            # past the last beat; clamp to mappable starts.
            n_chord_frames = min(beat_chroma.shape[1], len(beat_times_local))
            for col in range(n_chord_frames):
                v = beat_chroma[:, col]
                vn = _np.linalg.norm(v) + 1e-8
                sim = (v @ T) / (vn * norms_T)
                chord_seq.append(labels[int(_np.argmax(sim))])
            # Mode filter (radius 1 → window=3): replace each label with
            # the majority of {prev, self, next}. Works in O(N) for our
            # tiny vocabulary.
            if len(chord_seq) >= 3:
                smoothed = list(chord_seq)
                for i in range(1, len(chord_seq) - 1):
                    window = [chord_seq[i - 1], chord_seq[i], chord_seq[i + 1]]
                    counts: dict[str, int] = {}
                    for lab in window:
                        counts[lab] = counts.get(lab, 0) + 1
                    # max() with stable tie-break keeps the centre label.
                    best = max(counts.items(), key=lambda kv: (kv[1], kv[0] == chord_seq[i]))
                    smoothed[i] = best[0]
                chord_seq = smoothed
            # Run-length compression.
            segments: list[dict[str, Any]] = []
            if chord_seq:
                run_start_beat = 0
                cur = chord_seq[0]
                for i in range(1, len(chord_seq)):
                    if chord_seq[i] != cur:
                        segments.append({
                            "start": round(float(beat_times_local[run_start_beat]), 3),
                            "end":   round(float(beat_times_local[i]), 3),
                            "chord": cur,
                        })
                        run_start_beat = i
                        cur = chord_seq[i]
                end_t = float(beat_times_local[min(n_chord_frames, len(beat_times_local) - 1)])
                if len(beat_times_local) > 1 and end_t <= float(beat_times_local[run_start_beat]):
                    end_t = float(beat_times_local[run_start_beat]) + (
                        float(beat_times_local[-1] - beat_times_local[-2])
                    )
                segments.append({
                    "start": round(float(beat_times_local[run_start_beat]), 3),
                    "end":   round(end_t, 3),
                    "chord": cur,
                })
            out["chordProgression"] = segments[:512]
    except Exception as e:
        out["_chord_error"] = str(e)

    # ── Waveform overview peaks (for UI scrubber / mixer) ────────────
    # 2000 min/max pairs across the whole track is enough resolution for
    # any reasonable overview canvas (~2px per peak at 4K). The companion
    # writes these as Int16 to a sidecar .peaks file keyed by track id.
    # Heavy zoom levels (>1px ≈ 1 sample) decode the audio file directly;
    # a multi-resolution pyramid is a future enhancement.
    try:
        target_points = 2000
        n = len(y)
        if n > 0:
            bucket = max(1, n // target_points)
            actual_points = n // bucket
            # Reshape to (points, bucket) and take min/max — vectorized,
            # ~10ms even on 10-minute tracks.
            trimmed = y[: actual_points * bucket].reshape(actual_points, bucket)
            mins = trimmed.min(axis=1)
            maxs = trimmed.max(axis=1)
            # Interleave: [min0, max0, min1, max1, ...] — matches what the
            # browser-side renderer expects (single Int16Array decode).
            peak_norm = max(float(_np.max(_np.abs(y))), 1e-6)
            mins_i = (mins / peak_norm * 32767.0).astype(_np.int16)
            maxs_i = (maxs / peak_norm * 32767.0).astype(_np.int16)
            interleaved = _np.empty(actual_points * 2, dtype=_np.int16)
            interleaved[0::2] = mins_i
            interleaved[1::2] = maxs_i
            # Hex-encode for clean JSON transport (avoids base64 padding
            # quirks in some serialisers and keeps the data inspectable).
            out["waveformPeaksHex"] = interleaved.tobytes().hex()
            out["waveformPeaksCount"] = actual_points
    except Exception as e:
        out["_waveform_error"] = str(e)

    return out


# ─── AcoustID fingerprint ────────────────────────────────────────────


# Camelot wheel mapping: musical key → mix-friendly notation used by
# every modern DJ app. Compatible keys are (-1, 0, +1, swap-letter)
# on the wheel — clients use this for harmonic-mixing suggestions.
_CAMELOT_MAJOR = {
    "C": "8B", "G": "9B", "D": "10B", "A": "11B", "E": "12B",
    "B": "1B", "F#": "2B", "C#": "3B", "G#": "4B", "D#": "5B",
    "A#": "6B", "F": "7B",
}
_CAMELOT_MINOR = {
    "A":  "8A", "E":  "9A", "B":  "10A", "F#": "11A", "C#": "12A",
    "G#": "1A", "D#": "2A", "A#": "3A", "F":  "4A", "C":  "5A",
    "G":  "6A", "D":  "7A",
}
# Enharmonic aliases (audio-DSP land tends to spell sharps; users
# often type flats). Keep both lookup directions covered.
_ENHARMONIC = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


def _to_camelot(note: str, scale: str) -> str:
    n = _ENHARMONIC.get(note, note)
    table = _CAMELOT_MINOR if scale.lower().startswith("min") else _CAMELOT_MAJOR
    return table.get(n, "")


def _fingerprint(path: str) -> dict[str, Any]:
    aid = _try_import_pyacoustid()
    if aid is None:
        raise RuntimeError(
            "pyacoustid not installed — `pip install pyacoustid` "
            "and ensure the `fpcalc` binary is on PATH "
            "(https://acoustid.org/chromaprint).")
    duration, fingerprint = aid.fingerprint_file(path)
    return {
        "acoustidFingerprint": fingerprint.decode("ascii") if isinstance(fingerprint, bytes) else fingerprint,
        "fingerprintDurationSec": float(duration),
    }


# ─── Command dispatch ────────────────────────────────────────────────


def handle_ping(cmd: dict[str, Any]) -> None:
    _try_import_baseline()
    _try_import_librosa()
    _try_import_pyloudnorm()
    _try_import_pyacoustid()
    _try_import_audio_separator()
    # Plugin host (pedalboard) availability — optional, only needed
    # when the user opens the plugin rack.
    try:
        import plugins as _plugins_mod  # type: ignore
        _AVAILABLE["pedalboard"] = _plugins_mod.has_pedalboard()
    except Exception:
        _AVAILABLE["pedalboard"] = False
    gpu = _detect_gpu()
    _result_ok(cmd["id"], {
        "available": dict(_AVAILABLE),
        "python": sys.version,
        "platform": sys.platform,
        "executable": sys.executable,
        "gpu": gpu,
    })


def handle_gpu_install(cmd: dict[str, Any]) -> None:
    """Pip-install GPU acceleration packages into the running interpreter.

    target="onnx"  → swap onnxruntime → onnxruntime-gpu (powers audio-separator's
                    UVR/Roformer/MDX models).
    target="torch" → reinstall torch+torchaudio from PyTorch's CUDA index
                    (powers audio-separator's Demucs models).
    target="all"   → do both.

    The user MUST also have a working CUDA + cuDNN runtime on PATH (CUDA Toolkit
    on Windows). nvidia-smi confirms the driver is present, but the runtime libs
    are a separate install we can't bundle. After install we ask the companion
    to restart the sidecar so the new providers register.
    """
    job_id = cmd.get("id", "?")
    target = cmd.get("target", "onnx")
    if target not in ("onnx", "torch", "all"):
        _result_err(job_id, f"unknown target {target!r}")
        return
    try:
        import subprocess
        # CUDA 12.x is what PyTorch ships against in 2026 (Demucs/Roformer
        # tested on cu121 — cu124 wheels are also available). We pin to cu121
        # which is the broadest-compat tag.
        plans: list[list[list[str]]] = []
        if target in ("onnx", "all"):
            plans.append([
                [sys.executable, "-m", "pip", "uninstall", "-y", "onnxruntime", "onnxruntime-silicon"],
                [sys.executable, "-m", "pip", "install", "--upgrade", "onnxruntime-gpu"],
            ])
        if target in ("torch", "all"):
            plans.append([
                [sys.executable, "-m", "pip", "uninstall", "-y", "torch", "torchaudio"],
                [sys.executable, "-m", "pip", "install", "--upgrade",
                 "torch", "torchaudio",
                 "--index-url", "https://download.pytorch.org/whl/cu121"],
            ])
        log_lines: list[str] = []
        total_steps = sum(len(p) for p in plans)
        step_idx = 0
        for plan in plans:
            for step in plan:
                step_idx += 1
                pct = step_idx / max(1, total_steps + 1)
                short = " ".join(step[step.index("pip") + 1:]) if "pip" in step else " ".join(step)
                _progress(job_id, "gpu_install", pct, f"running: pip {short}")
                r = subprocess.run(step, capture_output=True, text=True)
                log_lines.append(f"$ {' '.join(step)}")
                if r.stdout:
                    log_lines.append(r.stdout[-3000:])
                if r.returncode != 0:
                    if r.stderr:
                        log_lines.append("STDERR:\n" + r.stderr[-3000:])
                    _result_err(
                        job_id,
                        f"pip step failed (code {r.returncode}): "
                        + (r.stderr or r.stdout or "")[-500:],
                    )
                    return
        _progress(job_id, "gpu_install", 0.99, "verifying providers…")
        # Re-probe after install (best-effort — the new module may not be
        # importable until the sidecar restarts since onnxruntime caches
        # its provider list at import time).
        post = _detect_gpu()
        _result_ok(job_id, {
            "installed": target,
            "restartRequired": True,
            "gpu": post,
            "log": "\n".join(log_lines)[-6000:],
        })
    except Exception as e:
        _result_err(job_id, f"install failed: {type(e).__name__}: {e}")


# Maps a missing `_AVAILABLE` flag → the pip requirement that provides it.
# `audio-separator[cpu]` pulls onnxruntime + torch (CPU) so stems work without
# a GPU; GPU acceleration is a separate opt-in via `gpu_install`.
_DEP_PACKAGES = {
    "numpy": "numpy",
    "soundfile": "soundfile",
    "librosa": "librosa",
    "pyloudnorm": "pyloudnorm",
    "pyacoustid": "pyacoustid",
    "audio_separator": "audio-separator[cpu]",
}


def handle_deps_install(cmd: dict[str, Any]) -> None:
    """Pip-install the CORE analyzer deps into the running interpreter.

    Triggered automatically by the companion on startup when `health` reports
    missing packages, so DSP / loudness / fingerprint / stems work without the
    user touching a terminal. Idempotent: pip no-ops already-satisfied
    requirements. `packages` may be passed to scope the install; otherwise we
    install everything currently missing from `_AVAILABLE`.
    """
    job_id = cmd.get("id", "?")
    try:
        import subprocess
        _try_import_baseline()
        requested = cmd.get("packages")
        if isinstance(requested, list) and requested:
            pkgs = [p for p in requested if isinstance(p, str) and p]
        else:
            # Default: every known dep that's currently unavailable.
            pkgs = [
                pip_name
                for flag, pip_name in _DEP_PACKAGES.items()
                if not _AVAILABLE.get(flag, False)
            ]
        # De-dup while preserving order.
        seen: set[str] = set()
        pkgs = [p for p in pkgs if not (p in seen or seen.add(p))]
        if not pkgs:
            _result_ok(job_id, {"installed": [], "available": _AVAILABLE, "log": "all deps present"})
            return

        log_lines: list[str] = []
        # One pip invocation for all packages — pip resolves the set together,
        # which avoids conflicting transitive pins. `--upgrade` is intentionally
        # NOT used: we only want to add what's missing, never churn versions.
        step = [sys.executable, "-m", "pip", "install", *pkgs]
        _progress(job_id, "deps_install", 0.1, f"installing: {' '.join(pkgs)}")
        r = subprocess.run(step, capture_output=True, text=True)
        log_lines.append(f"$ {' '.join(step)}")
        if r.stdout:
            log_lines.append(r.stdout[-4000:])
        if r.returncode != 0:
            if r.stderr:
                log_lines.append("STDERR:\n" + r.stderr[-4000:])
            _result_err(
                job_id,
                f"pip install failed (code {r.returncode}): "
                + (r.stderr or r.stdout or "")[-500:],
            )
            return
        _progress(job_id, "deps_install", 0.95, "verifying imports…")
        # Re-probe so the result reflects what's now importable. Some modules
        # (e.g. audio_separator) only become importable after a fresh process,
        # so we still ask the companion to restart the sidecar.
        _try_import_baseline()
        _result_ok(job_id, {
            "installed": pkgs,
            "restartRequired": True,
            "available": _AVAILABLE,
            "log": "\n".join(log_lines)[-6000:],
        })
    except Exception as e:
        _result_err(job_id, f"deps install failed: {type(e).__name__}: {e}")


def handle_plugins(cmd: dict[str, Any]) -> None:
    """Dispatch `plugins.*` commands to the pedalboard module."""
    job_id = cmd.get("id", "?")
    kind = cmd.get("kind", "")
    try:
        # Lazy import — keeps `ping` cheap even if pedalboard is missing.
        import plugins as plugins_mod  # type: ignore
    except Exception as e:
        _result_err(job_id, f"plugins module load failed: {e}")
        return
    handler = plugins_mod.COMMANDS.get(kind)
    if handler is None:
        _result_err(job_id, f"unknown plugin command: {kind!r}")
        return

    def _emit(stage: str, pct: float, msg: str) -> None:
        _progress(job_id, stage, pct, msg)

    try:
        out = handler(cmd, _emit)
        _result_ok(job_id, out)
    except Exception as e:
        _result_err(job_id, f"{e.__class__.__name__}: {e}\n{traceback.format_exc()}")


def handle_analyze(cmd: dict[str, Any]) -> None:
    job_id = cmd["id"]
    path = cmd.get("path")
    if not path or not os.path.exists(path):
        _result_err(job_id, f"file not found: {path!r}")
        return
    options = cmd.get("options") or {}
    out_dir = cmd.get("outDir") or ""
    data: dict[str, Any] = {}

    _try_import_baseline()

    try:
        if options.get("dsp"):
            _progress(job_id, "dsp", 0.05, "Decoding & beat tracking…")
            def _dsp_progress(pct: float, msg: str) -> None:
                # Map the DSP-internal 0..0.45 range onto the global
                # progress bar so each sub-stage shows a visible jump.
                _progress(job_id, "dsp", pct, msg)
            data.update(_dsp_analyze(path, progress=_dsp_progress))
            _progress(job_id, "dsp", 0.45, "DSP done.")

        if options.get("fingerprint"):
            _progress(job_id, "fp", 0.50, "Computing Chromaprint…")
            try:
                data.update(_fingerprint(path))
            except Exception as e:
                data["_fingerprint_error"] = str(e)
            _progress(job_id, "fp", 0.55, "Fingerprint done.")

        if options.get("stems"):
            # Default = htdemucs_ft (Demucs v4 fine-tuned, 4-stem). It's
            # the best general-purpose model for DJ workflows: gives
            # vocals + drums + bass + other with SDR 9.20 dB on
            # MUSDB18-HQ. BS-Roformer beats it on vocals-only (11.14
            # dB on MVSEP) but only outputs 2 stems (vocals + instr.),
            # which leaves the Mixer/DAW without drums/bass. Power
            # users can override via the `stemsModel` option.
            model = options.get("stemsModel") or "htdemucs_ft"
            _progress(job_id, "stems", 0.60, f"Loading stems model {model}…")
            stems = _separate_stems(path, out_dir, model, job_id)
            data["stems"] = stems
            data["stemsModel"] = model
            _progress(job_id, "stems", 0.95, "Stems separated.")

        # Sanity-gate: if the caller requested a category but the
        # primary field for that category is missing AND we captured
        # an underlying error, fail the sub-job with that error rather
        # than returning ok=true with empty data. Otherwise the
        # companion marks the job "done", the library row is never
        # updated, and the bulk-analyze skip filter re-enqueues the
        # exact same broken job on every subsequent batch.
        missing = []
        if options.get("dsp") and "bpm" not in data:
            missing.append(("dsp", data.get("_dsp_error") or "DSP returned no BPM"))
        if options.get("fingerprint") and "acoustidFingerprint" not in data:
            missing.append(("fingerprint", data.get("_fingerprint_error") or "fingerprint not produced (is fpcalc on PATH?)"))
        if options.get("stems") and "stems" not in data:
            missing.append(("stems", data.get("_stems_error") or "stems not produced"))
        if missing:
            # Surface the first underlying reason — most informative
            # for the user (e.g. "fpcalc not found on PATH").
            cat, why = missing[0]
            _result_err(job_id, f"{cat}: {why}")
            return

        _progress(job_id, "done", 1.0, "Complete.")
        _result_ok(job_id, data)
    except Exception as e:
        _result_err(job_id, f"{e.__class__.__name__}: {e}\n{traceback.format_exc()}")


def main() -> int:
    # Unbuffered stdout is critical for line-delimited JSON IPC.
    try:
        sys.stdout.reconfigure(line_buffering=True)  # py3.7+
    except Exception:
        pass

    _send({"kind": "ready", "pid": os.getpid(), "ts": time.time()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            _send({"kind": "fatal", "error": f"bad json: {e}"})
            continue
        kind = cmd.get("kind")
        if kind == "ping":
            handle_ping(cmd)
        elif kind == "analyze":
            handle_analyze(cmd)
        elif kind == "shutdown":
            return 0
        elif kind == "gpu_install":
            handle_gpu_install(cmd)
        elif kind == "deps_install":
            handle_deps_install(cmd)
        elif kind and kind.startswith("plugins."):
            handle_plugins(cmd)
        else:
            _result_err(cmd.get("id", "?"), f"unknown kind: {kind!r}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
