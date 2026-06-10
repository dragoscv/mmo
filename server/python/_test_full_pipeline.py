"""Full pipeline: ACE-Step generate → Demucs 4-stem split.

The Suno-beating loop: text/lyrics in → 4 DAW-ready stems out.
"""
import json, subprocess, sys, os, time, pathlib

ROOT = pathlib.Path(__file__).parent
ACE_SCRIPT = ROOT / "ace_step_sidecar.py"
ACE_PY = ROOT / ".venvs" / "ace_step" / "Scripts" / "python.exe"
DEMUCS_SCRIPT = ROOT / "demucs_sidecar.py"
DEMUCS_PY = sys.executable  # base env

OUTDIR = ROOT / "_test_full_pipeline"
OUTDIR.mkdir(exist_ok=True)
SONG_WAV = OUTDIR / "song.wav"
STEMS_DIR = OUTDIR / "stems"
STEMS_DIR.mkdir(exist_ok=True)

env = {k: v for k, v in os.environ.items() if k != "PYTHONNOUSERSITE"}


def drive(py: str, script: str, req: dict, label: str) -> dict | None:
    print(f"\n=== {label} ===")
    p = subprocess.Popen(
        [py, script], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", bufsize=1, env=env,
    )
    hello = json.loads(p.stdout.readline())
    print(f"  hello: {hello['engineId']} installed={hello['installed']} device={hello['device']['type']}")
    p.stdin.write(json.dumps(req) + "\n"); p.stdin.flush()

    t0 = time.time()
    data = None
    while True:
        line = p.stdout.readline()
        if not line:
            break
        evt = json.loads(line)
        kind = evt.get("kind")
        if kind == "progress":
            print(f"  [+{time.time()-t0:6.1f}s] {evt.get('stage')} pct={evt.get('pct')} {evt.get('msg') or ''}")
        elif kind == "result":
            ok = evt.get("ok")
            print(f"  [+{time.time()-t0:6.1f}s] result ok={ok}")
            if ok:
                data = evt.get("data")
            else:
                print("  ERROR:", evt.get("error"))
            break

    p.stdin.close()
    err = p.stderr.read()
    p.wait(timeout=10)
    if not data and err.strip():
        print("  STDERR (last 1KB):", err[-1000:])
    return data


# Step 1: generate a short song
gen = drive(str(ACE_PY), str(ACE_SCRIPT), {
    "id": "g1", "kind": "acestep.generate",
    "args": {
        "prompt": "upbeat romanian folk-pop, female vocals, accordion, 120bpm",
        "lyrics": "[verse]\nSoarele rasare peste sat\n[chorus]\nHai sa cantam impreuna toti",
        "durationSec": 15.0,
        "inferStep": 30,
        "outputPath": str(SONG_WAV),
    },
}, "ACE-Step generate")

if not gen or not os.path.exists(gen.get("audioPath", "")):
    print("ACE-Step failed; aborting")
    sys.exit(1)

print(f"\n  -> song produced: {gen['audioPath']} ({os.path.getsize(gen['audioPath'])/1024:.0f} KB)")

# Step 2: split into 4 stems
sep = drive(str(DEMUCS_PY), str(DEMUCS_SCRIPT), {
    "id": "s1", "kind": "demucs.separate",
    "args": {
        "inputPath": gen["audioPath"],
        "outputDir": str(STEMS_DIR),
        "model": "htdemucs",
        "twoStems": False,
    },
}, "Demucs separate")

print("\n=== FINAL ===")
if sep:
    for stem_name, path in (sep.get("stems") or {}).items():
        size = os.path.getsize(path) / 1024 if os.path.exists(path) else 0
        print(f"  {stem_name:8s} {size:6.0f} KB  {path}")
    print(f"\nSong + 4 stems ready for DAW. sr={sep.get('sampleRate')} model={sep.get('model')} device={sep.get('device')}")
else:
    print("Demucs failed")
