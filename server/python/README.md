# Python audio analyzer (sidecar)

This folder hosts the Python sidecar the companion spawns for **real**
audio analysis: source separation (BS-Roformer / Mel-Roformer / Demucs),
DSP (BPM, key, loudness, beats, chord progression) and Chromaprint
fingerprinting.

It is launched by [`server/src/library/analyzer.ts`](../src/library/analyzer.ts)
via `child_process.spawn` and speaks line-delimited JSON over stdin/stdout.

---

## Requirements

- **Python 3.10 – 3.12** (3.13 is not yet supported by some torch wheels)
- ~3 GB free disk for the default model cache
- ~4 GB RAM during separation, ~2 GB peak otherwise
- Optional: NVIDIA GPU with CUDA 12 for ~10× faster separation

## Install

### CPU (default — works everywhere)

```bash
pip install --upgrade pip
pip install "audio-separator[cpu]" essentia pyloudnorm pyacoustid soundfile numpy pedalboard
```

### GPU (CUDA 12, NVIDIA only)

```bash
pip install --upgrade pip
pip install "audio-separator[gpu]" librosa pyloudnorm pyacoustid soundfile numpy pedalboard
```

### Apple Silicon (CoreML acceleration)

```bash
pip install "audio-separator[cpu]" librosa pyloudnorm pyacoustid soundfile numpy pedalboard
# audio-separator will auto-detect MPS via onnxruntime-silicon if installed:
pip install onnxruntime-silicon
```

### Voice cloning (XTTS-v2 / F5-TTS) — optional, for `/voice-wizard`

The companion's `voice_clone.py` sidecar uses [Coqui TTS](https://github.com/coqui-ai/TTS)
for zero-shot voice cloning (XTTS-v2 multilingual model) plus `librosa` for
the sung-mode pitch alignment.

> **Use Python 3.10–3.12.** Coqui-TTS depends on PyTorch + torchcodec
> wheels that are not yet published for Python 3.13. On Windows we ship
> `dev-companion.ps1` defaulting `MMO_PYTHON` to `C:\Python312\python.exe`.

```bash
pip install --prefer-binary "coqui-tts[codec]" "transformers<5,>=4.57" soundfile numpy librosa
pip install --prefer-binary torch torchaudio --index-url https://download.pytorch.org/whl/cpu
```

Notes:

- `coqui-tts 0.27.x` pins `transformers>=4.57` but breaks on the 5.x line
  (`isin_mps_friendly` removed) — keep the upper bound.
- The `[codec]` extra pulls in `torchcodec`, required since PyTorch 2.9
  for audio I/O.
- For CUDA, drop the `--index-url cpu` flag and follow
  <https://pytorch.org/get-started/locally/>.

First inference downloads ~2 GB of model weights into the user's HuggingFace
cache. The XTTS-v2 weights ship under the **Coqui Public Model License (CPML)**
which permits non-commercial / personal use — appropriate for cloning *your own*
voice inside MMO. The wrapper auto-accepts the CPML by setting
`COQUI_TOS_AGREED=1`. F5-TTS is detected automatically when its Python package
is on `PATH`; otherwise `provider="f5"` is reported as "not-implemented".

### Chromaprint binary (`fpcalc`) — required for fingerprinting

`pyacoustid` calls the native `fpcalc` binary. Install it once:

- **Windows** (Chocolatey): `choco install chromaprint`
- **Windows** (manual): download from <https://acoustid.org/chromaprint>
  and make sure `fpcalc.exe` is on `%PATH%` (or set `FPCALC=C:\path\to\fpcalc.exe`).
- **macOS** (Homebrew): `brew install chromaprint`
- **Linux** (Debian/Ubuntu): `sudo apt install libchromaprint-tools`

## Telling the companion which Python to use

The companion spawns whatever `python` / `python3` is on `PATH` by default.
Override with:

```bash
# Windows (PowerShell)
$env:MMO_PYTHON = "C:\Python312\python.exe"

# macOS / Linux
export MMO_PYTHON=/usr/bin/python3.12
```

## Models

Models are downloaded **on first use** by `audio-separator` into your
user model cache. The default is **`htdemucs_ft`** (Demucs v4 hybrid
transformer, fine-tuned), which gives a balanced 4-stem split
(vocals/drums/bass/other) at SDR 9.20 dB on MUSDB18-HQ — the best
general-purpose model for a DJ workflow.

For the absolute best **vocal isolation** specifically, switch to
BS-Roformer (`model_bs_roformer_ep_317_sdr_12.9755`) which leads the
[MVSEP leaderboard](https://mvsep.com/quality_checker/leaderboard.php)
at 11.14 dB SDR for vocals — but it only outputs 2 stems (vocals +
instrumental), which won't populate drums/bass in the Mixer.

To swap models, send a different `stemsModel` in the request body of
`POST /library/analyze` (no extension needed; the analyzer auto-resolves
`.yaml` for Demucs and `.ckpt` for Roformer)._

Recommended:

| Model id                                   | Stems  | Notes                          |
| ------------------------------------------ | ------ | ------------------------------ |
| `htdemucs_ft` *(default)*                  | 4-stem | Best general-purpose, balanced |
| `htdemucs_6s`                              | 6-stem | + piano + guitar (experimental) |
| `model_bs_roformer_ep_317_sdr_12.9755`     | 2-stem | Best vocals (vocals+instr)     |
| `mel_band_roformer_kim_ft_unwa.ckpt`       | 4-stem | Faster Roformer alternative    |

## Wire protocol

### From companion (stdin)

```jsonc
{ "id": "<uuid>", "cmd": "ping" }
{ "id": "<uuid>", "cmd": "analyze", "path": "/abs/path.mp3",
  "stemsDir": "/abs/userData/stems/<trackId>",
  "options": { "dsp": true, "fingerprint": true,
                "stems": true, "stemsModel": "model_bs_roformer_ep_317_sdr_12.9755" } }
{ "id": "<uuid>", "cmd": "shutdown" }
```

### From sidecar (stdout, NDJSON)

```jsonc
{ "kind": "ready" }                                       // first line on startup
{ "kind": "progress", "id": "...", "stage": "stems",      // 0..1 progress for current job
  "pct": 0.42, "msg": "BS-Roformer..." }
{ "kind": "result",   "id": "...", "ok": true,
  "data": { "bpm": 128.0, "bpmConfidence": 0.92,
            "keyMusical": "C# minor", "keyConfidence": 0.81,
            "energy": 7,
            "loudnessLufs": -8.4, "loudnessTruePeakDbfs": -0.6, "loudnessRangeLu": 5.2,
            "beats": [...], "downbeats": [...],
            "chordProgression": [{"start":0.0,"end":2.0,"chord":"Cm"}, ...],
            "acoustidFingerprint": "AQAA...", 
            "stems": { "vocals":"...", "drums":"...", "bass":"...", "other":"...", "instrumental":"..." },
            "stemsModel": "model_bs_roformer_ep_317_sdr_12.9755" } }
{ "kind": "result",   "id": "...", "ok": false, "error": "..." }
```
