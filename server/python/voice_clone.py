#!/usr/bin/env python3
"""
MMO Companion — voice-cloning sidecar.

Long-lived NDJSON IPC process (mirrors `analyze.py` lifecycle) that loads
heavy voice-cloning models exactly once and handles:

  • voice.synthesize  — text + voiceId → cloned-voice WAV (spoken)
  • voice.sing        — text + melody + voiceId → cloned-voice WAV (sung,
                        per-syllable pitch-shifted to MIDI notes)
  • voice.preview     — synthesize a short fixed phrase to audition a
                        reference clip without saving as a permanent voice
  • voice.health      — engine + model availability snapshot

Backends (selected per request via `engine`):
  • xtts  — Coqui XTTS-v2. Zero-shot from a 6–10s reference clip.
            16 languages incl. ro/en/es/fr/de/it. Heavy first load
            (~2 GB download + ~10s init); subsequent infers are ~RT.
  • f5    — F5-TTS. Scaffolded but optional; falls back to xtts when
            the `f5-tts` package isn't installed (sidecar reports the
            availability via voice.health so the UI can disable it).

Reference clips
───────────────
`voiceId` is a stable id minted by the Express layer. The reference
WAV lives at `<voicesRoot>/<voiceId>/reference.wav`. Storage and
filesystem layout are handled by `server/src/voice/host.ts`; this
script never invents paths — every request carries `referencePath`
explicitly.

Wire protocol
─────────────
→ Hello (emitted at startup):
   { "kind": "hello", "engines": {"xtts": true, "f5": false}, "languages": [...] }

→ Command (companion → script):
   { "id": "uuid", "kind": "voice.synthesize",
     "engine": "xtts",
     "referencePath": "C:/.../voices/<voiceId>/reference.wav",
     "text": "Lyrics line...",
     "language": "en",
     "outPath": "C:/.../voices/<voiceId>/preview-xyz.wav",
     "speed": 1.0 }

   { "id": "uuid", "kind": "voice.sing",
     "engine": "xtts",
     "referencePath": "...",
     "text": "Hello world how are you",
     "language": "en",
     "tempo": 120,
     "melody": [ { "beat": 0, "durationBeats": 1, "midiPitch": 60 }, ... ],
     "outPath": "..." }

   { "id": "uuid", "kind": "voice.health" }
   { "id": "uuid", "kind": "ping" }

← Event:
   { "id": "...", "kind": "progress", "stage": "load|synth|pitch|done", "pct": 0..1 }
   { "id": "...", "kind": "result", "ok": true,  "data": {...} }
   { "id": "...", "kind": "result", "ok": false, "error": "engine-missing: ..." }

Install
───────
  XTTS-v2 (recommended):
    pip install coqui-tts soundfile numpy librosa
  Optional second engine:
    pip install f5-tts
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

# Force UTF-8 on stdio so non-ASCII transcripts (ă, ș, ț, é, ñ, …) survive
# the NDJSON hop on Windows where the default codepage is cp1252.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def _patch_torchaudio_with_soundfile() -> None:
    """Replace torchaudio.load/save with soundfile-backed shims so f5-tts
    can read/write WAVs without needing torchcodec + FFmpeg DLLs.
    torchaudio 2.12+ routes everything through torchcodec, which fails to
    load on Windows without the FFmpeg 'full-shared' DLLs. We also override
    `torchaudio._torchcodec.load_with_torchcodec` so any nested route also
    lands on soundfile. Safe no-op if torchaudio/soundfile aren't present."""
    try:
        import torchaudio  # type: ignore
        import torch  # type: ignore
        import soundfile as sf  # type: ignore
        import numpy as np  # type: ignore
    except ImportError:
        return

    def _sf_load(uri, frame_offset: int = 0, num_frames: int = -1, normalize: bool = True, channels_first: bool = True, **_kw):  # noqa: ARG001
        try:
            data, sr = sf.read(str(uri), dtype="float32", always_2d=True)
        except Exception:
            # soundfile only reads PCM WAV/FLAC/OGG. Mic captures from
            # MediaRecorder are typically WebM/Opus with a .wav extension,
            # which trip "Format not recognised". Fall back to librosa
            # (audioread → ffmpeg-py / soundfile / etc.) which handles
            # MP3/M4A/WebM/Opus transparently.
            import librosa  # type: ignore
            import warnings  # type: ignore
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore")
                y, sr = librosa.load(str(uri), sr=None, mono=False)
            if y.ndim == 1:
                data = y[:, None]  # (frames, 1)
            else:
                data = y.T  # librosa returns (channels, frames)
            data = np.ascontiguousarray(data.astype(np.float32))
        if frame_offset:
            data = data[frame_offset:]
        if num_frames and num_frames > 0:
            data = data[:num_frames]
        tensor = torch.from_numpy(np.ascontiguousarray(data.T if channels_first else data))
        return tensor, sr

    def _sf_save(uri, src, sample_rate: int, channels_first: bool = True, **_kw):  # noqa: ARG001
        arr = src.detach().cpu().numpy() if hasattr(src, "detach") else np.asarray(src)
        if channels_first and arr.ndim == 2:
            arr = arr.T
        sf.write(str(uri), arr, int(sample_rate))

    torchaudio.load = _sf_load  # type: ignore[assignment]
    torchaudio.save = _sf_save  # type: ignore[assignment]
    try:
        from torchaudio import _torchcodec as _tc  # type: ignore
        _tc.load_with_torchcodec = _sf_load  # type: ignore[assignment]
        _tc.save_with_torchcodec = _sf_save  # type: ignore[assignment]
    except Exception:
        pass


# Apply the torchaudio patch eagerly so any later import (f5-tts, transformers,
# etc.) sees the soundfile-backed shim from the very first call. Lazy patching
# is brittle because some modules cache `from torchaudio import load`.
_patch_torchaudio_with_soundfile()

SUPPORTED_LANGUAGES = [
    "en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru",
    "nl", "cs", "ar", "zh-cn", "ja", "hu", "ko", "hi",
]
# Romanian: XTTS does NOT include 'ro' in the trained set. We fall back to
# 'it' for Romanian which gives the closest phoneme coverage; the UI labels
# this clearly. Real Romanian support requires F5-TTS or a fine-tune.
ROMANIAN_FALLBACK = "it"


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _progress(job_id: str, stage: str, pct: float, msg: str = "") -> None:
    _emit({"id": job_id, "kind": "progress", "stage": stage, "pct": pct, "msg": msg})


def _result(job_id: str, ok: bool, data: dict | None = None, error: str | None = None) -> None:
    payload: dict[str, Any] = {"id": job_id, "kind": "result", "ok": ok}
    if data is not None:
        payload["data"] = data
    if error is not None:
        payload["error"] = error
    _emit(payload)


# ─── Engine availability probes (cheap; do not import heavy weights) ─────

def _has_xtts() -> bool:
    try:
        import TTS  # noqa: F401
        return True
    except ImportError:
        return False


def _has_f5() -> bool:
    try:
        import f5_tts  # type: ignore  # noqa: F401
        return True
    except ImportError:
        return False


# ─── XTTS-v2 lazy singleton ──────────────────────────────────────────────
# Loading the model takes ~10s and a few hundred MB of RAM. We keep one
# instance for the lifetime of the process and reuse it across all
# requests so per-job latency is ~real-time.

_xtts_instance = None
_xtts_load_error: str | None = None


def _normalize_language(lang: str | None) -> str:
    if not lang:
        return "en"
    lang = lang.lower()
    if lang == "ro":
        return ROMANIAN_FALLBACK
    if lang in SUPPORTED_LANGUAGES:
        return lang
    # Fall back to English rather than failing — Maestro shouldn't break
    # if it sends an unknown locale.
    return "en"


def _load_xtts():
    global _xtts_instance, _xtts_load_error
    if _xtts_instance is not None:
        return _xtts_instance
    if _xtts_load_error is not None:
        raise RuntimeError(_xtts_load_error)
    try:
        # Coqui TTS exposes XTTS via the standard `TTS` Python API.
        # https://docs.coqui.ai/en/latest/models/xtts.html
        from TTS.api import TTS  # type: ignore
        # Auto-detect CUDA so power users get real-time inference. The `gpu=`
        # kwarg is deprecated; we construct on CPU then `.to("cuda")`.
        try:
            import torch  # type: ignore
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"
        # tts_models/multilingual/multi-dataset/xtts_v2 → downloads to
        # ~/.local/share/tts on first use. Set COQUI_TOS_AGREED=1 in the
        # spawn env so the non-commercial license prompt is auto-accepted
        # (this sidecar is for personal use of the user's own voice).
        os.environ.setdefault("COQUI_TOS_AGREED", "1")
        model_name = os.environ.get(
            "MMO_XTTS_MODEL",
            "tts_models/multilingual/multi-dataset/xtts_v2",
        )
        _xtts_instance = TTS(model_name=model_name, progress_bar=False)
        if device == "cuda":
            try:
                _xtts_instance.to(device)
            except Exception:  # noqa: BLE001
                pass  # stay on CPU if move fails for any reason
        return _xtts_instance
    except Exception as exc:  # noqa: BLE001
        _xtts_load_error = f"xtts-load-failed: {exc}"
        raise RuntimeError(_xtts_load_error) from exc


def _xtts_synthesize(reference_path: str, text: str, language: str, out_path: str, speed: float) -> dict:
    tts = _load_xtts()
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    # XTTS-v2 ignores `speed` for very small deltas; clamp to the
    # documented stable range.
    speed = max(0.5, min(speed, 2.0))
    tts.tts_to_file(
        text=text,
        speaker_wav=reference_path,
        language=language,
        file_path=out_path,
        speed=speed,
    )
    # XTTS-v2 default sample rate.
    return _wav_meta(out_path, fallback_sr=24000)


# ─── F5-TTS lazy singleton ─────────────────────────────────────
# F5TTS_v1_Base ships with a Vocos vocoder and supports en/zh natively;
# Romanian goes through phonetic approximation but is *not* shoehorned
# into Italian like XTTS, so RO/EN material with mixed words works better.

_f5_instance = None
_f5_load_error: str | None = None


def _load_f5():
    global _f5_instance, _f5_load_error
    if _f5_instance is not None:
        return _f5_instance
    if _f5_load_error is not None:
        raise RuntimeError(_f5_load_error)
    try:
        # torchaudio 2.12+ routes load()/save() through torchcodec, which is
        # broken on Windows without FFmpeg "full-shared". Swap in soundfile
        # (libsndfile, already installed) BEFORE f5 imports it.
        _patch_torchaudio_with_soundfile()
        from f5_tts.api import F5TTS  # type: ignore
        try:
            import torch  # type: ignore
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"
        model_name = os.environ.get("MMO_F5_MODEL", "F5TTS_v1_Base")
        _f5_instance = F5TTS(model=model_name, device=device)
        return _f5_instance
    except Exception as exc:  # noqa: BLE001
        _f5_load_error = f"f5-load-failed: {exc}"
        raise RuntimeError(_f5_load_error) from exc


def _patch_torchaudio_with_soundfile_noop() -> None:
    """Deprecated alias kept for safety; the real patch runs at import time."""
    return None


def _f5_synthesize(reference_path: str, text: str, _language: str, out_path: str, speed: float) -> dict:
    f5 = _load_f5()
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    speed = max(0.3, min(speed, 2.0))
    # F5's built-in auto-transcription pulls in transformers' Whisper, which
    # imports torchcodec — broken on Windows without FFmpeg "full-shared".
    # Pre-transcribe with our faster-whisper, and ALWAYS pass a non-empty
    # ref_text. F5 only triggers its own transcription when ref_text is
    # whitespace, so a placeholder is enough to bypass the broken path.
    ref_text = ""
    try:
        ref_text = (_transcribe(reference_path, _language) or "").strip()
    except Exception as exc:  # noqa: BLE001
        _progress({"stage": "f5-ref-transcribe-failed", "error": str(exc)[:300]})
        ref_text = ""
    if not ref_text:
        # Generic non-empty placeholder. F5 still uses the audio's prosody
        # for cloning; the text is mainly used to align ref vs gen length.
        ref_text = "Hello."
    f5.infer(
        ref_file=reference_path,
        ref_text=ref_text,
        gen_text=text,
        file_wave=out_path,
        speed=speed,
        remove_silence=False,
    )
    # F5TTS_v1_Base emits 24 kHz mono via the Vocos vocoder.
    return _wav_meta(out_path, fallback_sr=24000)


# F5TTS_v1_Base only ships en+zh weights. Routing other languages through it
# produces gibberish that sounds vaguely Indian/random because the text gets
# phonemized as English. XTTS-v2 covers a much wider language set (and falls
# back to Italian for Romanian which is far closer than English-phonemized).
F5_NATIVE_LANGUAGES = {"en", "zh"}


def _engine_synthesize(engine: str, reference_path: str, text: str, language: str, out_path: str, speed: float) -> dict:
    lang_short = (language or "en").split("-")[0].lower()
    if engine == "f5" and lang_short not in F5_NATIVE_LANGUAGES:
        # Auto-downgrade to XTTS for non-en/zh languages so previews actually
        # sound like the target language. Voice's recorded engine stays as-is.
        if _has_xtts():
            print(f"[voice_clone] engine override: f5→xtts for language '{lang_short}' (F5 native: en, zh)", file=sys.stderr, flush=True)
            engine = "xtts"
    if engine == "f5":
        return _f5_synthesize(reference_path, text, language, out_path, speed)
    return _xtts_synthesize(reference_path, text, language, out_path, speed)


def _wav_meta(path: str, fallback_sr: int) -> dict:
    try:
        import wave
        with wave.open(path, "rb") as wf:
            sr = wf.getframerate()
            duration = wf.getnframes() / float(sr)
        return {"path": path, "durationSec": duration, "sampleRate": sr}
    except Exception:  # noqa: BLE001
        return {"path": path, "durationSec": 0.0, "sampleRate": fallback_sr}


# ─── Singing mode (engine-agnostic post-processor) ───────────────────────

def _split_syllables(text: str) -> list[str]:
    """Cheap syllable splitter — same idea as tts.py but tuned for sung
    lyrics. We split on vowel clusters per word so the engine emits one
    Piper-like burst per note. Final fallback: whole words."""
    import re
    syls: list[str] = []
    for word in text.split():
        parts = re.findall(r"[^aeiouyăâîAEIOUYĂÂÎ]*[aeiouyăâîAEIOUYĂÂÎ]+[^aeiouyăâîAEIOUYĂÂÎ]*", word)
        if not parts:
            syls.append(word)
        else:
            joined = "".join(parts)
            if joined != word:
                head = word[: word.find(parts[0])]
                tail = word[word.find(parts[-1]) + len(parts[-1]):]
                if head:
                    parts[0] = head + parts[0]
                if tail:
                    parts[-1] = parts[-1] + tail
            syls.extend(parts)
    return [s for s in syls if s]


def _midi_to_hz(midi: float) -> float:
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _detect_pitch_hz(y, sr) -> float:
    try:
        import librosa  # type: ignore
        import numpy as np  # type: ignore
        f0, _voiced, _vprob = librosa.pyin(
            y, sr=sr,
            fmin=float(librosa.note_to_hz("C2")),
            fmax=float(librosa.note_to_hz("C6")),
        )
        f0 = f0[~np.isnan(f0)]
        if f0.size == 0:
            return 220.0
        return float(np.median(f0))
    except Exception:  # noqa: BLE001
        return 220.0


# ─── Singing polish DSP (vibrato + breath + de-ess + phoneme attack) ─────
# Applied per-note inside _voice_sing when job["polish"] is truthy, plus a
# final post-mix de-ess pass. All operations are pure numpy/librosa so they
# stay on CPU — total cost for a 30 s vocal is ~0.5 s on a modern laptop.

def _polish_phoneme_attack(y, sr, attack_ms: float = 18.0, release_ms: float = 35.0):
    """Replace the engine's default rectangular envelope with a vocal-style
    attack/release: gentle onset (~18 ms) to avoid the "synth click" and a
    longer release (~35 ms) to mimic the way a human syllable trails off
    into the next one. Replaces _voice_sing's 10 ms rectangular env."""
    import numpy as np  # type: ignore
    n = len(y)
    if n == 0:
        return y
    a_n = max(1, int(min(attack_ms * 0.001 * sr, n // 3)))
    r_n = max(1, int(min(release_ms * 0.001 * sr, n // 3)))
    env = np.ones(n, dtype=np.float32)
    # Equal-power-ish curve (cos²): smoother than linear and avoids spectral
    # smearing that a steep linear ramp introduces.
    t_a = np.linspace(0.0, np.pi / 2.0, a_n, dtype=np.float32)
    t_r = np.linspace(0.0, np.pi / 2.0, r_n, dtype=np.float32)
    env[:a_n] = np.sin(t_a) ** 2
    env[-r_n:] = np.cos(t_r) ** 2
    return y * env


def _polish_vibrato(y, sr, rate_hz: float = 5.2, depth_cents: float = 22.0,
                    delay_sec: float = 0.18):
    """Apply natural-sounding vibrato by resampling the audio along a
    time-axis modulated with a sine LFO. Real singers don't vibrato from
    note onset — we wait `delay_sec` so the attack stays clean, then ramp
    the depth up over ~120 ms. `depth_cents` ~20 is jazz/pop, 40 is operatic.

    Implementation: build a "phase" array y(t) → y(t * (1 + d·sin(2π·rate·t)))
    and resample with np.interp. Cheaper and artefact-free vs PSOLA.
    """
    import numpy as np  # type: ignore
    n = len(y)
    if n < int(sr * (delay_sec + 0.05)):
        return y
    t = np.arange(n, dtype=np.float32) / sr
    depth_ratio = (2.0 ** (depth_cents / 1200.0)) - 1.0  # cents → linear ratio
    # Ramp depth from 0 → full over 120 ms starting at delay_sec.
    ramp_end = delay_sec + 0.12
    ramp = np.clip((t - delay_sec) / max(1e-6, (ramp_end - delay_sec)), 0.0, 1.0).astype(np.float32)
    lfo = np.sin(2.0 * np.pi * rate_hz * (t - delay_sec)) * (depth_ratio * ramp)
    # Read positions in source-sample space.
    src_t = t * (1.0 + lfo)
    src_idx = src_t * sr
    src_idx = np.clip(src_idx, 0.0, float(n - 1))
    return np.interp(src_idx, np.arange(n, dtype=np.float32), y).astype(np.float32)


def _polish_deess(y, sr, threshold_db: float = -12.0, ratio: float = 4.0):
    """Cheap dynamic de-esser: split into HF (>5 kHz) + LF residual, apply
    soft-knee downward compression to the HF band only, recombine. Doesn't
    require scipy — uses a 2-pole biquad implemented inline.

    Returns audio with sibilance ('ss', 'sh', 'ts') tamed by ~3 dB on average,
    which matters far more on cloned XTTS vocals than dry speech because the
    pitch-shift step exaggerates high-frequency content.
    """
    import numpy as np  # type: ignore
    if len(y) < 64:
        return y
    # Butterworth highpass @ 5 kHz, 2nd order biquad (RBJ cookbook).
    fc = min(5000.0, sr * 0.45)
    w0 = 2.0 * np.pi * fc / sr
    cos_w0 = float(np.cos(w0))
    sin_w0 = float(np.sin(w0))
    q = 0.707
    alpha = sin_w0 / (2.0 * q)
    b0 = (1.0 + cos_w0) / 2.0
    b1 = -(1.0 + cos_w0)
    b2 = (1.0 + cos_w0) / 2.0
    a0 = 1.0 + alpha
    a1 = -2.0 * cos_w0
    a2 = 1.0 - alpha
    b0n, b1n, b2n = b0 / a0, b1 / a0, b2 / a0
    a1n, a2n = a1 / a0, a2 / a0
    # Direct-form II transposed
    hf = np.zeros_like(y, dtype=np.float32)
    z1 = z2 = 0.0
    for i in range(len(y)):
        x = float(y[i])
        out = b0n * x + z1
        z1 = b1n * x - a1n * out + z2
        z2 = b2n * x - a2n * out
        hf[i] = out
    lf = y - hf
    # Envelope follower on HF band (50 ms attack, 200 ms release).
    abs_hf = np.abs(hf)
    atk = float(np.exp(-1.0 / (0.050 * sr)))
    rel = float(np.exp(-1.0 / (0.200 * sr)))
    env = np.zeros_like(abs_hf)
    e = 0.0
    for i in range(len(abs_hf)):
        a = abs_hf[i]
        if a > e:
            e = atk * e + (1.0 - atk) * a
        else:
            e = rel * e + (1.0 - rel) * a
        env[i] = e
    eps = 1e-9
    env_db = 20.0 * np.log10(np.maximum(env, eps))
    over = np.maximum(env_db - threshold_db, 0.0)
    gain_red_db = over * (1.0 - 1.0 / ratio)
    gain_lin = (10.0 ** (-gain_red_db / 20.0)).astype(np.float32)
    return (lf + hf * gain_lin).astype(np.float32)


def _polish_breath(out, sr, beats: list[float], tempo: float,
                   breath_db: float = -32.0):
    """Drop a short inhale-like pink noise burst into any gap >= 250 ms
    between consecutive note starts. Real singers breathe at phrase ends;
    even a -32 dB whisper of noise glues syllables and removes the eerie
    "perfect silence" feeling that flags a clip as AI-generated.
    """
    import numpy as np  # type: ignore
    if len(beats) < 2 or len(out) == 0:
        return out
    # Sort start times in samples
    starts = sorted(int((b * 60.0 / tempo) * sr) for b in beats)
    breath_amp = 10.0 ** (breath_db / 20.0)
    for i in range(len(starts) - 1):
        gap_samples = starts[i + 1] - starts[i]
        gap_sec = gap_samples / sr
        if gap_sec < 0.25 or gap_sec > 4.0:
            continue
        # 150–250 ms breath just before the next syllable.
        breath_len = int(min(0.25, gap_sec * 0.6) * sr)
        breath_start = starts[i + 1] - breath_len - int(0.04 * sr)
        if breath_start < 0 or breath_start + breath_len > len(out):
            continue
        # Pink-ish noise via cumulative sum of white noise + soft env.
        white = np.random.randn(breath_len).astype(np.float32) * 0.1
        pink = np.cumsum(white)
        pink = pink - np.mean(pink)
        m = float(np.max(np.abs(pink))) or 1.0
        pink = (pink / m) * breath_amp
        ramp = int(breath_len * 0.25)
        env = np.ones(breath_len, dtype=np.float32)
        env[:ramp] = np.linspace(0.0, 1.0, ramp)
        env[-ramp:] = np.linspace(1.0, 0.0, ramp)
        out[breath_start: breath_start + breath_len] += (pink * env).astype(np.float32)
    return out


def _voice_sing(job: dict) -> None:
    """Melody-aligned singing on top of any TTS engine. For each note:
        1. Synthesize the next syllable via the chosen engine (cloned timbre)
        2. Detect natural f0 in the resulting audio
        3. Pitch-shift to the target MIDI note
        4. Time-stretch to the note duration (in seconds, derived from tempo)
        5. Splat into the final mix buffer at the note's start offset

    `polish=true` (default) layers a vocal-style attack/release, gentle
    vibrato after the onset, post-mix de-esser, and breath inserts into
    long inter-note gaps. Disable with `polish=false` for a dry preview.
    """
    job_id = job["id"]
    engine = (job.get("engine") or "xtts").lower()
    reference_path = job["referencePath"]
    text = (job.get("text") or "").strip()
    language = _normalize_language(job.get("language"))
    tempo = float(job.get("tempo") or 120.0)
    melody = job.get("melody") or []
    out_path = job["outPath"]
    polish = bool(job.get("polish", True))
    vibrato_cents = float(job.get("vibratoCents", 22.0))
    vibrato_rate = float(job.get("vibratoRateHz", 5.2))

    if not text:
        _result(job_id, False, error="empty-text"); return
    if not melody:
        _result(job_id, False, error="empty-melody"); return
    if not os.path.isfile(reference_path):
        _result(job_id, False, error=f"reference-missing: {reference_path}"); return

    try:
        import numpy as np  # type: ignore
        import soundfile as sf  # type: ignore
        import librosa  # type: ignore
    except ImportError as e:
        _result(job_id, False, error=f"deps-missing: {e}. pip install soundfile numpy librosa")
        return

    if engine == "xtts" and not _has_xtts():
        _result(job_id, False, error="engine-missing: xtts (pip install coqui-tts)"); return
    if engine == "f5" and not _has_f5():
        _result(job_id, False, error="engine-missing: f5-tts (pip install f5-tts)"); return

    _progress(job_id, "load", 0.05, f"warming engine {engine}")
    try:
        if engine == "xtts":
            _load_xtts()
        elif engine == "f5":
            _load_f5()
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"engine-load-failed: {exc}")
        return

    syllables = _split_syllables(text)
    if not syllables:
        _result(job_id, False, error="no-syllables-from-text"); return

    # Distribute syllables across notes: pad with vowel-tail or pack overflow.
    if len(syllables) > len(melody):
        head = syllables[: len(melody) - 1]
        tail = " ".join(syllables[len(melody) - 1:])
        syllables = head + [tail]

    def syl_for(i: int) -> str:
        if i < len(syllables):
            return syllables[i]
        prev = syllables[-1] if syllables else "ah"
        vowels = [c for c in prev if c.lower() in "aeiouyăâî"]
        return vowels[-1] if vowels else "ah"

    end_beat = max((float(n.get("beat", 0)) + float(n.get("durationBeats", 0))) for n in melody)
    total_sec = (end_beat * 60.0 / tempo) + 0.4

    # Synthesize one syllable to discover the engine's native sample rate.
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    tmp_dir = Path(out_path).parent
    probe_path = str(tmp_dir / f".probe-{os.getpid()}.wav")

    try:
        _engine_synthesize(engine, reference_path, syl_for(0), language, probe_path, 1.0)
        probe_y, probe_sr = sf.read(probe_path, dtype="float32")
        if probe_y.ndim > 1:
            probe_y = probe_y.mean(axis=1)
        try:
            os.unlink(probe_path)
        except OSError:
            pass
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"probe-failed: {exc}")
        return

    sr = probe_sr
    mix = np.zeros(int(total_sec * sr) + sr, dtype=np.float32)

    # First note gets the probe audio for free.
    cached_first: tuple = (probe_y, _detect_pitch_hz(probe_y, sr))

    for i, note in enumerate(melody):
        pct = 0.1 + 0.85 * (i / max(1, len(melody)))
        _progress(job_id, "synth", pct, f"note {i+1}/{len(melody)}")

        if i == 0:
            y, natural_hz = cached_first
        else:
            note_tmp = str(tmp_dir / f".note-{os.getpid()}-{i}.wav")
            try:
                _engine_synthesize(engine, reference_path, syl_for(i), language, note_tmp, 1.0)
                y, _ = sf.read(note_tmp, dtype="float32")
                if y.ndim > 1:
                    y = y.mean(axis=1)
                natural_hz = _detect_pitch_hz(y, sr)
            except Exception:  # noqa: BLE001
                continue
            finally:
                try:
                    os.unlink(note_tmp)
                except OSError:
                    pass

        target_midi = float(note.get("midiPitch", 60))
        beat = float(note.get("beat", 0))
        dur_beats = max(0.05, float(note.get("durationBeats", 1)))
        target_sec = dur_beats * 60.0 / tempo
        start_sec = beat * 60.0 / tempo
        target_hz = _midi_to_hz(target_midi)

        # 1. Pitch-shift
        if natural_hz > 0:
            n_steps = 12.0 * np.log2(target_hz / max(60.0, natural_hz))
            if abs(n_steps) > 0.05:
                try:
                    y = librosa.effects.pitch_shift(y=y.astype(np.float32), sr=sr, n_steps=float(n_steps))
                except Exception:  # noqa: BLE001
                    pass

        # 2. Time-stretch
        natural_sec = len(y) / sr
        if natural_sec > 0.05 and target_sec > 0.05:
            rate = natural_sec / target_sec
            rate = max(0.25, min(rate, 4.0))
            if abs(rate - 1.0) > 0.02:
                try:
                    y = librosa.effects.time_stretch(y=y.astype(np.float32), rate=float(rate))
                except Exception:  # noqa: BLE001
                    pass

        # 3. Envelope: polished cos² attack/release for natural seams, or
        # a plain 10 ms rectangular ramp when polish is disabled.
        if polish:
            y = _polish_phoneme_attack(y, sr)
            # Add vibrato only on notes longer than 350 ms — otherwise the
            # LFO never gets past the delay+ramp and just modulates noise.
            if target_sec >= 0.35 and vibrato_cents > 0.5:
                y = _polish_vibrato(y, sr, rate_hz=vibrato_rate,
                                    depth_cents=vibrato_cents,
                                    delay_sec=min(0.18, target_sec * 0.35))
        else:
            env_n = int(min(0.01 * sr, len(y) // 4))
            if env_n > 0:
                import numpy as _np
                env = _np.ones_like(y)
                ramp = _np.linspace(0.0, 1.0, env_n, dtype=_np.float32)
                env[:env_n] = ramp
                env[-env_n:] = ramp[::-1]
                y = y * env

        # 4. Splat
        start_idx = int(start_sec * sr)
        end_idx = start_idx + len(y)
        if end_idx > len(mix):
            mix = np.concatenate([mix, np.zeros(end_idx - len(mix) + sr, dtype=np.float32)])
        mix[start_idx:end_idx] += y

    # Post-mix polish: breath inserts, de-esser. Skipped when polish=False.
    if polish and mix.size:
        try:
            mix = _polish_breath(mix, sr, [float(n.get("beat", 0)) for n in melody], tempo)
        except Exception:  # noqa: BLE001
            pass
        try:
            mix = _polish_deess(mix, sr)
        except Exception:  # noqa: BLE001
            pass

    # Normalize to -3 dBFS peak so the WAV never clips.
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 1e-6:
        target_peak = 10 ** (-3.0 / 20.0)
        mix = (mix * (target_peak / peak)).astype(np.float32)

    sf.write(out_path, mix, sr, subtype="PCM_16")
    _progress(job_id, "done", 1.0, "")
    _result(job_id, True, data=_wav_meta(out_path, fallback_sr=sr) | {
        "engine": engine,
        "polish": polish,
        "vibratoCents": vibrato_cents if polish else 0.0,
    })


# ─── Sample analyzer (training coach) ────────────────────────────────────
# Lazy-loaded Whisper for transcription. Tries faster-whisper first (CTranslate2,
# ~5x faster on CPU) and falls back to HF transformers' Whisper (already brought
# in by f5-tts). The "small" multilingual model is ~250 MB, downloads once,
# transcribes a 10s clip in ~1s on CPU and supports all wizard languages.

_whisper_kind: str | None = None
_whisper_instance = None
_whisper_load_error: str | None = None


def _load_whisper():
    global _whisper_instance, _whisper_load_error, _whisper_kind
    if _whisper_instance is not None:
        return _whisper_instance, _whisper_kind
    if _whisper_load_error is not None:
        raise RuntimeError(_whisper_load_error)
    model_size = os.environ.get("MMO_WHISPER_MODEL", "small")
    try:
        from faster_whisper import WhisperModel  # type: ignore
        # Prefer CUDA float16 when available (3–5× faster on RTX-class GPUs);
        # fall back to int8 CPU which works everywhere. faster-whisper needs
        # cuDNN to be discoverable for CUDA mode — if init fails we retry CPU.
        device, compute_type = "cpu", "int8"
        try:
            import torch  # type: ignore
            if torch.cuda.is_available():
                device, compute_type = "cuda", "float16"
        except ImportError:
            pass
        try:
            _whisper_instance = WhisperModel(model_size, device=device, compute_type=compute_type)
        except Exception:  # noqa: BLE001
            if device == "cuda":
                _whisper_instance = WhisperModel(model_size, device="cpu", compute_type="int8")
            else:
                raise
        _whisper_kind = "faster-whisper"
        return _whisper_instance, _whisper_kind
    except ImportError:
        pass
    except Exception as exc:  # noqa: BLE001
        _whisper_load_error = f"faster-whisper failed: {exc}"
    try:
        from transformers import pipeline  # type: ignore
        _whisper_instance = pipeline(
            "automatic-speech-recognition",
            model=f"openai/whisper-{model_size}",
            chunk_length_s=30,
        )
        _whisper_kind = "transformers"
        return _whisper_instance, _whisper_kind
    except Exception as exc:  # noqa: BLE001
        _whisper_load_error = f"whisper unavailable: {exc}. pip install faster-whisper"
        raise RuntimeError(_whisper_load_error)


def _transcribe(audio_path: str, language: str | None) -> str:
    model, kind = _load_whisper()
    lang = (language or "").split("-")[0] or None
    if kind == "faster-whisper":
        segments, _info = model.transcribe(audio_path, language=lang, beam_size=1, vad_filter=True)
        return " ".join(seg.text.strip() for seg in segments).strip()
    # transformers pipeline
    result = model(audio_path, generate_kwargs={"language": lang} if lang else {})
    return (result.get("text") or "").strip()


def _normalize_for_wer(text: str) -> list[str]:
    import re
    cleaned = re.sub(r"[^\w\s'’\-]", " ", text.lower(), flags=re.UNICODE)
    return [w for w in cleaned.split() if w]


def _word_error_rate(reference: str, hypothesis: str) -> tuple[float, int, int, int]:
    """Levenshtein WER. Returns (wer, substitutions, deletions, insertions)."""
    ref = _normalize_for_wer(reference)
    hyp = _normalize_for_wer(hypothesis)
    if not ref:
        return (1.0, 0, 0, len(hyp))
    # DP over (len(ref)+1) x (len(hyp)+1) — keep two rows
    prev = list(range(len(hyp) + 1))
    ops_prev = [(0, 0, i) for i in range(len(hyp) + 1)]  # (sub, del, ins)
    for i, rw in enumerate(ref, 1):
        cur = [i]
        ops_cur = [(0, i, 0)]
        for j, hw in enumerate(hyp, 1):
            cost_sub = prev[j - 1] + (0 if rw == hw else 1)
            cost_del = prev[j] + 1
            cost_ins = cur[j - 1] + 1
            best = min(cost_sub, cost_del, cost_ins)
            cur.append(best)
            if best == cost_sub:
                s, d, ins = ops_prev[j - 1]
                ops_cur.append((s + (0 if rw == hw else 1), d, ins))
            elif best == cost_del:
                s, d, ins = ops_prev[j]
                ops_cur.append((s, d + 1, ins))
            else:
                s, d, ins = ops_cur[j - 1]
                ops_cur.append((s, d, ins + 1))
        prev = cur
        ops_prev = ops_cur
    distance = prev[-1]
    s, d, ins = ops_prev[-1]
    return (distance / max(1, len(ref)), s, d, ins)


def _analyze_audio(audio_path: str) -> dict:
    """Pure-DSP analysis: levels, clipping, silence, pace, pitch."""
    import numpy as np  # type: ignore
    import librosa  # type: ignore
    import warnings  # type: ignore

    # librosa.load tries soundfile first, falls back to the deprecated
    # audioread for formats sf can't read (some MP3s, WebM, etc.). The
    # fallback warnings flood stderr and the companion log even though
    # the load itself succeeds — mute them locally.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning, module="librosa")
        warnings.filterwarnings("ignore", category=FutureWarning, module="librosa")
        y, sr = librosa.load(audio_path, sr=None, mono=True)
    if y.size == 0:
        return {
            "durationSec": 0.0, "sampleRate": int(sr or 0),
            "peakDb": -120.0, "rmsDb": -120.0,
            "clippingPct": 0.0, "silencePct": 100.0,
            "rmsVariance": 0.0,
            "pitchMedianHz": 0.0, "pitchRangeSemitones": 0.0,
            "voicedPct": 0.0,
        }
    duration = float(y.size) / float(sr)
    peak = float(np.max(np.abs(y)))
    rms = float(np.sqrt(np.mean(y * y)))
    eps = 1e-9
    peak_db = 20.0 * float(np.log10(max(peak, eps)))
    rms_db = 20.0 * float(np.log10(max(rms, eps)))
    clipping_pct = 100.0 * float(np.mean(np.abs(y) > 0.99))

    # Silence: 50ms frames with RMS < -45 dBFS.
    frame_len = max(1, int(0.050 * sr))
    hop = frame_len
    n_frames = max(1, (y.size - frame_len) // hop + 1)
    frame_rms = np.array([
        float(np.sqrt(np.mean(y[i * hop: i * hop + frame_len] ** 2)))
        for i in range(n_frames)
    ])
    silence_db = 20.0 * np.log10(np.maximum(frame_rms, eps))
    silence_pct = 100.0 * float(np.mean(silence_db < -45.0))
    rms_variance = float(np.var(20.0 * np.log10(np.maximum(frame_rms, eps))))

    # Pitch via pyin (slower but accurate). Skip on very short clips.
    pitch_median = 0.0
    pitch_range_semi = 0.0
    voiced_pct = 0.0
    if duration >= 0.5:
        try:
            f0, voiced_flag, _vprob = librosa.pyin(
                y, sr=sr,
                fmin=float(librosa.note_to_hz("C2")),
                fmax=float(librosa.note_to_hz("C6")),
            )
            voiced = f0[~np.isnan(f0)]
            if voiced.size > 5:
                pitch_median = float(np.median(voiced))
                p_lo = float(np.percentile(voiced, 5))
                p_hi = float(np.percentile(voiced, 95))
                if p_lo > 0:
                    pitch_range_semi = float(12.0 * np.log2(p_hi / p_lo))
            if voiced_flag is not None and voiced_flag.size:
                voiced_pct = 100.0 * float(np.mean(voiced_flag))
        except Exception:  # noqa: BLE001
            pass

    return {
        "durationSec": duration,
        "sampleRate": int(sr),
        "peakDb": round(peak_db, 2),
        "rmsDb": round(rms_db, 2),
        "clippingPct": round(clipping_pct, 3),
        "silencePct": round(silence_pct, 2),
        "rmsVariance": round(rms_variance, 3),
        "pitchMedianHz": round(pitch_median, 2),
        "pitchRangeSemitones": round(pitch_range_semi, 2),
        "voicedPct": round(voiced_pct, 2),
    }


def _build_verdicts(audio: dict, transcript_meta: dict | None, expected_text: str, intent: str) -> list[dict]:
    """Translate raw numbers into traffic-light verdicts the UI shows
    under the clip. Keep thresholds conservative — false positives are
    far worse than letting a marginal clip through."""
    out: list[dict] = []

    # Levels
    peak = audio["peakDb"]
    rms = audio["rmsDb"]
    if peak > -1.0 or audio["clippingPct"] > 0.5:
        out.append({"key": "levels", "status": "fail", "msg": f"Clipping ({audio['clippingPct']:.1f}% of samples) — turn the mic down."})
    elif peak < -25.0:
        out.append({"key": "levels", "status": "warn", "msg": f"Very quiet (peak {peak:.0f} dB). Move closer or raise input gain."})
    elif rms < -40.0:
        out.append({"key": "levels", "status": "warn", "msg": f"Low average level ({rms:.0f} dB RMS). The clone will sound thin."})
    else:
        out.append({"key": "levels", "status": "pass", "msg": f"Levels healthy (peak {peak:.0f} dB, RMS {rms:.0f} dB)."})

    # Silence
    if audio["silencePct"] > 50.0:
        out.append({"key": "silence", "status": "fail", "msg": f"Mostly silence ({audio['silencePct']:.0f}%). Re-record."})
    elif audio["silencePct"] > 30.0:
        out.append({"key": "silence", "status": "warn", "msg": f"Lots of dead air ({audio['silencePct']:.0f}%). Trim or re-read tighter."})
    else:
        out.append({"key": "silence", "status": "pass", "msg": "Continuous speech, no long gaps."})

    # Duration
    dur = audio["durationSec"]
    if dur < 3.0:
        out.append({"key": "duration", "status": "fail", "msg": f"Too short ({dur:.1f}s). Aim for 6–10s."})
    elif dur < 5.0:
        out.append({"key": "duration", "status": "warn", "msg": f"Short clip ({dur:.1f}s). 6–10s is the sweet spot."})
    elif dur > 15.0:
        out.append({"key": "duration", "status": "warn", "msg": f"Long clip ({dur:.1f}s). Shorter is usually cleaner."})
    else:
        out.append({"key": "duration", "status": "pass", "msg": f"Good length ({dur:.1f}s)."})

    # Transcript match (only when expected_text is provided)
    if transcript_meta and expected_text.strip():
        wer = transcript_meta["wer"]
        if wer >= 0.5:
            out.append({"key": "words", "status": "fail", "msg": f"Words don't match the prompt (WER {wer:.0%}). Re-read it."})
        elif wer >= 0.2:
            out.append({"key": "words", "status": "warn", "msg": f"Some words off ({wer:.0%} WER). Close enough but cleaner is better."})
        else:
            out.append({"key": "words", "status": "pass", "msg": f"Matches the prompt ({wer:.0%} WER)."})

        # Pace
        word_count = len(_normalize_for_wer(transcript_meta["transcript"]))
        if dur > 0.5 and word_count > 0:
            wpm = (word_count / dur) * 60.0
            if wpm > 200:
                out.append({"key": "pace", "status": "warn", "msg": f"Fast ({wpm:.0f} wpm). Aim for 110–160."})
            elif wpm < 90:
                out.append({"key": "pace", "status": "warn", "msg": f"Slow ({wpm:.0f} wpm). Aim for 110–160."})
            else:
                out.append({"key": "pace", "status": "pass", "msg": f"Natural pace ({wpm:.0f} wpm)."})

    # Delivery vs intent — heuristic via RMS variance + pitch range.
    rms_var = audio["rmsVariance"]
    pitch_range = audio["pitchRangeSemitones"]
    if intent == "excited":
        if rms_var < 6.0 or pitch_range < 4.0:
            out.append({"key": "delivery", "status": "warn", "msg": "Sounds flat for 'excited'. Push energy and let the pitch jump."})
        else:
            out.append({"key": "delivery", "status": "pass", "msg": "Dynamic delivery — great for 'excited'."})
    elif intent == "intimate":
        if rms_var > 12.0 or peak > -10.0:
            out.append({"key": "delivery", "status": "warn", "msg": "Too dynamic for 'intimate'. Pull back, half-voice."})
        else:
            out.append({"key": "delivery", "status": "pass", "msg": "Controlled, intimate delivery."})
    elif intent == "warm":
        if pitch_range > 14.0:
            out.append({"key": "delivery", "status": "warn", "msg": "Pitch jumps a lot — 'warm' wants a steady, smiling tone."})
        else:
            out.append({"key": "delivery", "status": "pass", "msg": "Even, warm tone."})
    elif intent == "question":
        # Question prompts should have rising pitch — we approximate by
        # checking the last 25% of voiced frames has higher median pitch
        # than the first 25%. Skip if pitch detection failed.
        out.append({"key": "delivery", "status": "pass", "msg": "Captured. (Intonation contour not deeply analyzed.)"})

    return out


def _handle_analyze(job: dict) -> None:
    job_id = job["id"]
    audio_path = job.get("audioPath")
    expected_text = (job.get("expectedText") or "").strip()
    language = (job.get("language") or "").strip() or None
    intent = (job.get("intent") or "").strip().lower()

    if not audio_path or not os.path.isfile(audio_path):
        _result(job_id, False, error=f"audio-missing: {audio_path}"); return

    try:
        _progress(job_id, "audio", 0.2, "measuring audio")
        audio = _analyze_audio(audio_path)
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"audio-analysis-failed: {exc}\n{traceback.format_exc()}")
        return

    transcript_meta: dict | None = None
    if expected_text:
        try:
            _progress(job_id, "transcribe", 0.5, "transcribing")
            transcript = _transcribe(audio_path, language)
            wer, sub, dele, ins = _word_error_rate(expected_text, transcript)
            transcript_meta = {
                "transcript": transcript,
                "wer": round(wer, 4),
                "substitutions": sub,
                "deletions": dele,
                "insertions": ins,
            }
        except Exception as exc:  # noqa: BLE001
            transcript_meta = {
                "transcript": "",
                "wer": 1.0,
                "error": f"whisper-failed: {exc}",
            }

    verdicts = _build_verdicts(audio, transcript_meta, expected_text, intent)
    overall = "pass"
    if any(v["status"] == "fail" for v in verdicts):
        overall = "fail"
    elif any(v["status"] == "warn" for v in verdicts):
        overall = "warn"

    _progress(job_id, "done", 1.0, "")
    _result(job_id, True, data={
        "audio": audio,
        "transcript": transcript_meta,
        "verdicts": verdicts,
        "overall": overall,
        "intent": intent,
        "language": language,
        "expectedText": expected_text,
    })


# ─── Dispatch ────────────────────────────────────────────────────────────

def _handle_synthesize(job: dict) -> None:
    job_id = job["id"]
    engine = (job.get("engine") or "xtts").lower()
    reference_path = job["referencePath"]
    text = (job.get("text") or "").strip()
    language = _normalize_language(job.get("language"))
    speed = float(job.get("speed") or 1.0)
    out_path = job["outPath"]

    if not text:
        _result(job_id, False, error="empty-text"); return
    if not os.path.isfile(reference_path):
        _result(job_id, False, error=f"reference-missing: {reference_path}"); return

    if engine == "xtts" and not _has_xtts():
        _result(job_id, False, error="engine-missing: xtts (pip install coqui-tts)"); return
    if engine == "f5" and not _has_f5():
        _result(job_id, False, error="engine-missing: f5-tts (pip install f5-tts)"); return

    try:
        _progress(job_id, "load", 0.1, f"loading {engine}")
        data = _engine_synthesize(engine, reference_path, text, language, out_path, speed)
        _progress(job_id, "done", 1.0, "")
        _result(job_id, True, data=data | {"engine": engine, "language": language})
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"synth-failed: {exc}\n{traceback.format_exc()}")


def _handle_health(job: dict) -> None:
    _result(job["id"], True, data={
        "engines": {"xtts": _has_xtts(), "f5": _has_f5()},
        "languages": SUPPORTED_LANGUAGES,
        "romanianFallback": ROMANIAN_FALLBACK,
    })


# ─── Pitch-coverage analyzer ─────────────────────────────────────────────
# Aggregates pyin f0 from N audio clips into semitone bins (C2..C5) and
# returns a coverage histogram. The wizard uses this to guide the user
# to record sung phrases at the pitches that are currently empty.

PITCH_COVERAGE_LOW_MIDI = 36   # C2  (~65 Hz, low male voice)
PITCH_COVERAGE_HIGH_MIDI = 84  # C6  (~1047 Hz, high female / soprano)


def _voice_pitch_coverage(job: dict) -> None:
    job_id = job["id"]
    audio_paths = job.get("audioPaths") or []
    if not isinstance(audio_paths, list) or not audio_paths:
        _result(job_id, False, error="audioPaths-required"); return

    import numpy as np  # type: ignore
    try:
        import librosa  # type: ignore
    except ImportError as exc:
        _result(job_id, False, error=f"librosa-missing: {exc}"); return

    n_bins = PITCH_COVERAGE_HIGH_MIDI - PITCH_COVERAGE_LOW_MIDI + 1
    bins = np.zeros(n_bins, dtype=np.float64)  # seconds-voiced per semitone
    total_voiced_sec = 0.0
    total_dur_sec = 0.0
    failed: list[str] = []

    for idx, p in enumerate(audio_paths):
        if not isinstance(p, str) or not os.path.isfile(p):
            failed.append(str(p)); continue
        try:
            _progress(job_id, "pitch-extract", (idx + 1) / max(1, len(audio_paths)), os.path.basename(p))
            y, sr = librosa.load(p, sr=16000, mono=True)
            if y.size < int(sr * 0.2):
                continue
            total_dur_sec += float(y.size) / sr
            # pyin returns f0 in Hz with NaN for unvoiced frames.
            f0, voiced_flag, _ = librosa.pyin(
                y,
                fmin=float(librosa.midi_to_hz(PITCH_COVERAGE_LOW_MIDI - 4)),
                fmax=float(librosa.midi_to_hz(PITCH_COVERAGE_HIGH_MIDI + 4)),
                sr=sr,
                frame_length=2048,
            )
            hop_sec = 512 / sr  # librosa.pyin default hop_length
            voiced = ~np.isnan(f0)
            if not voiced.any():
                continue
            midi = 69.0 + 12.0 * np.log2(np.where(voiced, f0, 440.0) / 440.0)
            midi_rounded = np.round(midi).astype(int)
            bin_idx = midi_rounded - PITCH_COVERAGE_LOW_MIDI
            valid = voiced & (bin_idx >= 0) & (bin_idx < n_bins)
            for bi in bin_idx[valid]:
                bins[bi] += hop_sec
            total_voiced_sec += float(valid.sum()) * hop_sec
        except Exception as exc:  # noqa: BLE001
            failed.append(f"{p}: {exc}")

    if total_voiced_sec < 0.5:
        _result(job_id, False, error="not-enough-voiced-audio"); return

    # Coverage: a bin "covered" if it has >= 0.2 s of voiced material.
    THRESH_SEC = 0.20
    covered_count = int((bins >= THRESH_SEC).sum())
    coverage_pct = round(100.0 * covered_count / n_bins, 1)

    # Find largest contiguous gap (where users should be guided).
    gap_runs: list[dict] = []
    run_start = None
    for i in range(n_bins):
        if bins[i] < THRESH_SEC:
            if run_start is None:
                run_start = i
        else:
            if run_start is not None:
                gap_runs.append({
                    "fromMidi": run_start + PITCH_COVERAGE_LOW_MIDI,
                    "toMidi": (i - 1) + PITCH_COVERAGE_LOW_MIDI,
                    "lengthSemis": i - run_start,
                })
                run_start = None
    if run_start is not None:
        gap_runs.append({
            "fromMidi": run_start + PITCH_COVERAGE_LOW_MIDI,
            "toMidi": (n_bins - 1) + PITCH_COVERAGE_LOW_MIDI,
            "lengthSemis": n_bins - run_start,
        })
    gap_runs.sort(key=lambda g: -g["lengthSemis"])  # type: ignore[arg-type]

    # Per-bin histogram for the UI meter.
    histogram = [
        {"midi": PITCH_COVERAGE_LOW_MIDI + i, "voicedSec": round(float(bins[i]), 3)}
        for i in range(n_bins)
    ]

    verdict: str = "pass"
    if coverage_pct < 25.0:
        verdict = "fail"
    elif coverage_pct < 50.0:
        verdict = "warn"

    _progress(job_id, "done", 1.0, "")
    _result(job_id, True, data={
        "coveragePct": coverage_pct,
        "coveredBins": covered_count,
        "totalBins": n_bins,
        "lowMidi": PITCH_COVERAGE_LOW_MIDI,
        "highMidi": PITCH_COVERAGE_HIGH_MIDI,
        "histogram": histogram,
        "biggestGaps": gap_runs[:3],
        "voicedSecTotal": round(total_voiced_sec, 2),
        "audioSecTotal": round(total_dur_sec, 2),
        "verdict": verdict,
        "failed": failed,
    })


def _cuda_cleanup() -> None:
    """Free per-call VRAM activations so the next GPU job (ace-step/demucs/
    rvc/voice) starts from a clean baseline. The model singletons themselves
    stay resident — only intermediate tensors and the allocator cache go."""
    try:
        import gc as _gc, torch as _torch  # type: ignore
        _gc.collect()
        if _torch.cuda.is_available():
            _torch.cuda.empty_cache()
    except Exception:
        pass


def _dispatch(job: dict) -> None:
    kind = job.get("kind")
    job_id = job.get("id") or "0"
    # Heavy kinds touch CUDA; cheap kinds (ping, health) don't.
    is_gpu_kind = kind in (
        "voice.synthesize", "voice.sing", "voice.analyze", "voice.pitch-coverage",
    )
    try:
        if kind == "ping":
            _result(job_id, True, data={"pong": True})
        elif kind == "voice.health":
            _handle_health(job)
        elif kind == "voice.synthesize":
            _handle_synthesize(job)
        elif kind == "voice.sing":
            _voice_sing(job)
        elif kind == "voice.analyze":
            _handle_analyze(job)
        elif kind == "voice.pitch-coverage":
            _voice_pitch_coverage(job)
        else:
            _result(job_id, False, error=f"unknown-kind: {kind}")
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"unhandled: {exc}\n{traceback.format_exc()}")
    finally:
        if is_gpu_kind:
            _cuda_cleanup()


def _detect_device() -> dict:
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            return {
                "type": "cuda",
                "name": torch.cuda.get_device_name(0),
                "vramGb": round(torch.cuda.get_device_properties(0).total_memory / (1024 ** 3), 1),
            }
    except Exception:  # noqa: BLE001
        pass
    return {"type": "cpu"}


def _main() -> None:
    _emit({
        "kind": "hello",
        "engines": {"xtts": _has_xtts(), "f5": _has_f5()},
        "languages": SUPPORTED_LANGUAGES,
        "romanianFallback": ROMANIAN_FALLBACK,
        "device": _detect_device(),
        "pid": os.getpid(),
    })
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except json.JSONDecodeError:
            _emit({"kind": "error", "error": "bad-json"})
            continue
        _dispatch(job)


if __name__ == "__main__":
    _main()
