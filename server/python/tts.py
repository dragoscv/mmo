#!/usr/bin/env python3
"""
MMO Companion — text-to-speech (vocal synthesis) sidecar.

Spawned by the Electron companion as a child process. Newline-JSON IPC
mirrors analyze.py.

Backend: Piper-TTS (https://github.com/rhasspy/piper) — fast on CPU,
permissive license, ships small ONNX voices. Pitch post-shift uses
librosa if installed; otherwise the raw Piper output is returned.

Two synthesis modes:
  - synthesize  : plain TTS (optionally pitch-shifted as a single block)
  - sing        : melody-aligned. Splits the lyric into syllables, then
                  time-stretches + pitch-shifts each syllable to land
                  on the matching MIDI note. Result is robotic but on
                  pitch — gives Maestro real singing without a heavy
                  SVS model.

Wire protocol
─────────────
→ Command (companion → tts):
   { "id": "uuid", "kind": "ping" }
   { "id": "uuid", "kind": "synthesize",
     "text": "Lyrics line...",
     "voice": "male|female|neutral",
     "rate": 1.0, "pitchSemitones": 0,
     "outPath": "C:/.../voice-xyz.wav" }
   { "id": "uuid", "kind": "sing",
     "text": "Hello world how are you",
     "voice": "male|female|neutral",
     "tempo": 120,
     "melody": [ { "beat": 0, "durationBeats": 1, "midiPitch": 60 }, ... ],
     "outPath": "C:/.../voice-xyz.wav" }

← Event:
   {"id": "...", "kind": "progress", "stage": "load|synth|pitch|done", "pct": 0..1}
   {"id": "...", "kind": "result", "ok": true,  "data": {"path": "...", "durationSec": 3.4, "sampleRate": 22050}}
   {"id": "...", "kind": "result", "ok": false, "error": "piper-not-installed: pip install piper-tts"}

Install
───────
  pip install piper-tts soundfile numpy librosa

Voices are downloaded on first use from huggingface.co/rhasspy/piper-voices.
The mapping below picks a sensible default per requested gender; users can
override by setting $MMO_PIPER_VOICE_<MALE|FEMALE|NEUTRAL>.
"""
import json
import os
import sys
import time
import traceback
from pathlib import Path

# Default voice models per gender (English, medium quality).
DEFAULT_VOICES = {
    "male":    os.environ.get("MMO_PIPER_VOICE_MALE",    "en_US-ryan-medium"),
    "female":  os.environ.get("MMO_PIPER_VOICE_FEMALE",  "en_US-amy-medium"),
    "neutral": os.environ.get("MMO_PIPER_VOICE_NEUTRAL", "en_US-lessac-medium"),
}


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _progress(job_id: str, stage: str, pct: float, msg: str = "") -> None:
    _emit({"id": job_id, "kind": "progress", "stage": stage, "pct": pct, "msg": msg})


def _result(job_id: str, ok: bool, data: dict | None = None, error: str | None = None) -> None:
    payload: dict = {"id": job_id, "kind": "result", "ok": ok}
    if data is not None:
        payload["data"] = data
    if error is not None:
        payload["error"] = error
    _emit(payload)


def _piper_cache_dir() -> Path:
    custom = os.environ.get("MMO_PIPER_CACHE_DIR")
    if custom:
        return Path(custom)
    return Path.home() / ".cache" / "mmo-piper"


def _load_piper_voice(voice_model: str):
    """Resolve {voice_model} to an on-disk .onnx, downloading if missing, then load it.

    `PiperVoice.load` in current piper-tts versions takes a path, not a name; it
    does not auto-download. We cache models under ~/.cache/mmo-piper (override
    with $MMO_PIPER_CACHE_DIR).
    """
    from piper import PiperVoice  # type: ignore
    cache = _piper_cache_dir()
    cache.mkdir(parents=True, exist_ok=True)
    onnx = cache / f"{voice_model}.onnx"
    if not onnx.exists():
        try:
            from piper.download_voices import download_voice  # type: ignore
        except ImportError as e:
            raise RuntimeError(f"cannot download voice (piper.download_voices missing): {e}") from e
        download_voice(voice_model, cache)
    return PiperVoice.load(str(onnx))


def _synthesize(job: dict) -> None:
    job_id = job["id"]
    text: str = (job.get("text") or "").strip()
    voice_key: str = (job.get("voice") or "neutral").lower()
    rate: float = float(job.get("rate") or 1.0)
    pitch_st: float = float(job.get("pitchSemitones") or 0)
    out_path: str = job["outPath"]

    if not text:
        _result(job_id, False, error="empty-text")
        return

    voice_model = DEFAULT_VOICES.get(voice_key, DEFAULT_VOICES["neutral"])

    try:
        _progress(job_id, "load", 0.05, f"loading piper voice {voice_model}")
        from piper import PiperVoice, SynthesisConfig  # type: ignore
    except ImportError:
        _result(job_id, False, error="piper-not-installed: pip install piper-tts")
        return

    try:
        voice = _load_piper_voice(voice_model)
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"voice-load-failed: {exc}")
        return

    try:
        _progress(job_id, "synth", 0.4, "synthesizing")
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        import wave
        syn_cfg = SynthesisConfig(length_scale=1.0 / max(0.1, rate))
        with wave.open(out_path, "wb") as wf:
            voice.synthesize_wav(text, wf, syn_config=syn_cfg)
        sr = voice.config.sample_rate
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"synth-failed: {exc}\n{traceback.format_exc()}")
        return

    if abs(pitch_st) > 0.01:
        try:
            _progress(job_id, "pitch", 0.75, f"pitch shift {pitch_st:+.1f} st")
            import numpy as np  # type: ignore
            import soundfile as sf  # type: ignore
            import librosa  # type: ignore
            y, file_sr = sf.read(out_path, dtype="float32")
            if y.ndim > 1:
                y = y.mean(axis=1)
            y_shifted = librosa.effects.pitch_shift(y=y, sr=file_sr, n_steps=pitch_st)
            sf.write(out_path, y_shifted, file_sr, subtype="PCM_16")
        except ImportError:
            # librosa unavailable — silently skip pitch shift
            pass
        except Exception as exc:  # noqa: BLE001
            _result(job_id, False, error=f"pitch-shift-failed: {exc}")
            return

    try:
        import wave
        with wave.open(out_path, "rb") as wf:
            duration = wf.getnframes() / float(wf.getframerate())
            sr = wf.getframerate()
    except Exception:  # noqa: BLE001
        duration = 0.0

    _progress(job_id, "done", 1.0, "")
    _result(job_id, True, data={
        "path": out_path,
        "durationSec": duration,
        "sampleRate": sr,
        "voiceModel": voice_model,
    })


def _split_syllables(text: str) -> list[str]:
    """Cheap-and-cheerful syllable splitter. Good enough for English-like
    lyrics where each MIDI note should carry roughly one syllable. We don't
    need pyphen accuracy — what matters is producing N segments to map onto
    N notes. Strategy:
      1. Split on whitespace into words.
      2. Inside each word, split on every vowel cluster boundary.
      3. Keep punctuation glued to the previous syllable so the TTS
         engine still inserts natural prosody.
    """
    import re
    syls: list[str] = []
    for word in text.split():
        # word may include trailing punctuation
        parts = re.findall(r"[^aeiouyAEIOUY]*[aeiouyAEIOUY]+[^aeiouyAEIOUY]*", word)
        if not parts:
            # no vowels (e.g. "hmm") — keep as one
            syls.append(word)
        else:
            # If the regex missed a leading consonant cluster, glue it onto the first part.
            joined = "".join(parts)
            if joined != word:
                # leftover suffix/prefix — append as a tail to the last syllable
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
    """Estimate the median voiced f0 of a Piper segment via librosa.pyin."""
    import numpy as np  # type: ignore
    import librosa  # type: ignore
    try:
        f0, _voiced, _vprob = librosa.pyin(
            y, sr=sr,
            fmin=float(librosa.note_to_hz("C2")),
            fmax=float(librosa.note_to_hz("C6")),
        )
        f0 = f0[~np.isnan(f0)]
        if f0.size == 0:
            # Fallback: assume Piper's natural pitch is ~C4 (261Hz) for male, A4 (220Hz) ish.
            return 220.0
        return float(np.median(f0))
    except Exception:  # noqa: BLE001
        return 220.0


def _sing(job: dict) -> None:
    """Melody-aligned synthesis. For each note in `melody` we:
        1. Take the next syllable from `text`
        2. Piper-synthesize that syllable on its own
        3. Pitch-shift it to the note's frequency (relative to detected f0)
        4. Time-stretch it to the note duration in seconds (= durationBeats * 60/tempo)
        5. Splat it at the note's start offset in a final mix buffer
    Gaps between notes become silence; overlapping notes are summed."""
    job_id = job["id"]
    text: str = (job.get("text") or "").strip()
    voice_key: str = (job.get("voice") or "neutral").lower()
    tempo: float = float(job.get("tempo") or 120.0)
    melody: list[dict] = job.get("melody") or []
    out_path: str = job["outPath"]

    if not text:
        _result(job_id, False, error="empty-text"); return
    if not melody:
        _result(job_id, False, error="empty-melody"); return

    voice_model = DEFAULT_VOICES.get(voice_key, DEFAULT_VOICES["neutral"])
    try:
        _progress(job_id, "load", 0.05, f"loading piper voice {voice_model}")
        from piper import PiperVoice, SynthesisConfig  # type: ignore
        import numpy as np  # type: ignore
        import soundfile as sf  # type: ignore
        import librosa  # type: ignore
        import wave
        import io
    except ImportError as e:
        _result(job_id, False, error=f"deps-missing: {e}. pip install piper-tts soundfile numpy librosa")
        return

    try:
        voice = _load_piper_voice(voice_model)
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"voice-load-failed: {exc}")
        return

    sr = voice.config.sample_rate
    syllables = _split_syllables(text)
    if not syllables:
        _result(job_id, False, error="no-syllables-from-text"); return

    # Spread syllables across notes. If we have more notes than syllables we
    # repeat the last syllable as a held vowel. If we have more syllables we
    # pack the leftovers onto the last note (cheap but predictable).
    def syl_for(i: int) -> str:
        if i < len(syllables):
            return syllables[i]
        # Try to extract a sung vowel from the previous syllable for a tail
        prev = syllables[-1] if syllables else "ah"
        vowels = [c for c in prev if c.lower() in "aeiouy"]
        return vowels[-1] if vowels else "ah"

    if len(syllables) > len(melody):
        # Group surplus syllables onto the last note
        head = syllables[: len(melody) - 1]
        tail = " ".join(syllables[len(melody) - 1:])
        syllables = head + [tail]

    # Compute total length: end of last note + small tail.
    end_beat = max((float(n.get("beat", 0)) + float(n.get("durationBeats", 0))) for n in melody)
    total_sec = (end_beat * 60.0 / tempo) + 0.25
    mix = np.zeros(int(total_sec * sr) + sr, dtype=np.float32)

    for i, note in enumerate(melody):
        pct = 0.1 + 0.85 * (i / max(1, len(melody)))
        _progress(job_id, "synth", pct, f"note {i+1}/{len(melody)}")

        syl = syl_for(i) if i < len(syllables) else syllables[-1]
        target_midi = float(note.get("midiPitch", 60))
        beat = float(note.get("beat", 0))
        dur_beats = max(0.05, float(note.get("durationBeats", 1)))
        target_sec = dur_beats * 60.0 / tempo
        start_sec = beat * 60.0 / tempo

        # 1. Synthesize this syllable directly via the streaming API and
        # accumulate int16 chunks into a float32 mono buffer at the voice's
        # native sample rate (the model exposes one sample_rate; ignore
        # per-chunk rate mismatches by trusting the config).
        chunks: list[np.ndarray] = []
        for chunk in voice.synthesize(syl, syn_config=SynthesisConfig(length_scale=1.0)):
            arr = np.asarray(chunk.audio_int16_array, dtype=np.int16)
            if arr.size == 0:
                continue
            chunks.append(arr.astype(np.float32) / 32768.0)
        if not chunks:
            continue
        y = np.concatenate(chunks)
        file_sr = sr  # piper streaming returns at voice.config.sample_rate

        # 2. Detect natural pitch + shift to target
        natural_hz = _detect_pitch_hz(y, sr)
        target_hz = _midi_to_hz(target_midi)
        if natural_hz > 0:
            n_steps = 12.0 * np.log2(target_hz / natural_hz)
            # Clamp absurd shifts (e.g. detection failed) to ±12 semitones
            n_steps = float(np.clip(n_steps, -18.0, 18.0))
            try:
                y = librosa.effects.pitch_shift(y=y, sr=sr, n_steps=n_steps)
            except Exception:
                pass

        # 3. Time-stretch to fit note duration. librosa.effects.time_stretch
        # uses phase vocoder; ratio < 1 makes it longer.
        current_sec = len(y) / sr
        if current_sec > 0 and target_sec > 0.02:
            ratio = current_sec / target_sec
            ratio = float(np.clip(ratio, 0.25, 4.0))
            if abs(ratio - 1.0) > 0.02:
                try:
                    y = librosa.effects.time_stretch(y=y, rate=ratio)
                except Exception:
                    pass

        # 4. Fade in/out 10ms to avoid clicks when summing
        fade_n = int(0.01 * sr)
        if len(y) > 2 * fade_n:
            fade = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
            y[:fade_n] *= fade
            y[-fade_n:] *= fade[::-1]

        # 5. Splat into the mix buffer at start_sec, summing for legato.
        start_n = int(start_sec * sr)
        end_n = min(len(mix), start_n + len(y))
        copy_n = end_n - start_n
        if copy_n > 0:
            mix[start_n:end_n] += y[:copy_n]

    # Soft limit so summed overlaps don't clip
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.95:
        mix *= (0.95 / peak)

    try:
        _progress(job_id, "pitch", 0.97, "writing wav")
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        sf.write(out_path, mix, sr, subtype="PCM_16")
    except Exception as exc:  # noqa: BLE001
        _result(job_id, False, error=f"write-failed: {exc}")
        return

    _progress(job_id, "done", 1.0, "")
    _result(job_id, True, data={
        "path": out_path,
        "durationSec": float(len(mix) / sr),
        "sampleRate": sr,
        "voiceModel": voice_model,
        "syllables": len(syllables),
        "notes": len(melody),
    })


def main() -> None:
    _emit({"kind": "hello", "service": "mmo-tts", "ts": time.time()})
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"kind": "error", "error": f"bad-json: {exc}"})
            continue

        kind = job.get("kind")
        job_id = job.get("id", "?")
        try:
            if kind == "ping":
                _result(job_id, True, data={"pong": True})
            elif kind == "synthesize":
                _synthesize(job)
            elif kind == "sing":
                _sing(job)
            else:
                _result(job_id, False, error=f"unknown-kind: {kind}")
        except Exception as exc:  # noqa: BLE001
            _result(job_id, False, error=f"unhandled: {exc}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
