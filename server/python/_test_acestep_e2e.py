"""End-to-end smoke: drive ace_step_sidecar via NDJSON, generate a short clip.

WARNING: First run downloads ~6GB of weights from HuggingFace.
"""
import json, subprocess, sys, os, time, pathlib

SCRIPT = pathlib.Path(__file__).parent / "ace_step_sidecar.py"
VENV_PY = pathlib.Path(__file__).parent / ".venvs" / "ace_step" / "Scripts" / "python.exe"
OUTDIR = pathlib.Path(__file__).parent / "_test_acestep"
OUTDIR.mkdir(exist_ok=True)
OUT_WAV = OUTDIR / "smoke.wav"

# Strip PYTHONNOUSERSITE so the venv inherits base env's CUDA torch.
env = {k: v for k, v in os.environ.items() if k != "PYTHONNOUSERSITE"}

p = subprocess.Popen(
    [str(VENV_PY), str(SCRIPT)],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8", bufsize=1, env=env,
)

hello = json.loads(p.stdout.readline())
print("HELLO:", hello["engineId"], "installed=", hello["installed"],
      "device=", hello["device"]["type"], "caps=", hello.get("capabilities"))
assert hello["installed"], "ace-step not installed in venv"

req = {
    "id": "g1",
    "kind": "acestep.generate",
    "args": {
        "prompt": "energetic electronic dance track, female vocals, 128bpm",
        "lyrics": "[verse]\nDance all night under neon lights\n[chorus]\nWe are alive, we are alive",
        "durationSec": 10.0,
        "inferStep": 20,  # low for smoke test
        "outputPath": str(OUT_WAV),
    },
}
print("SEND:", req["kind"], "infer_step=20 duration=10s")
p.stdin.write(json.dumps(req) + "\n"); p.stdin.flush()

t0 = time.time()
result = None
try:
    while True:
        line = p.stdout.readline()
        if not line:
            break
        evt = json.loads(line)
        kind = evt.get("kind")
        if kind == "progress":
            print(f"  [+{time.time()-t0:6.1f}s] progress stage={evt.get('stage')} pct={evt.get('pct')} msg={evt.get('msg')}")
        elif kind == "result":
            result = evt
            print(f"  [+{time.time()-t0:6.1f}s] RESULT ok={evt.get('ok')} data=", json.dumps(evt.get("data"), indent=2))
            break
        elif kind == "error":
            print(f"  [+{time.time()-t0:6.1f}s] ERROR", evt)
            break
        else:
            print(f"  [+{time.time()-t0:6.1f}s] {kind}", evt)
except KeyboardInterrupt:
    pass

p.stdin.close()
err = p.stderr.read()
if err.strip():
    print("STDERR (last 2KB):", err[-2000:])
try:
    p.wait(timeout=10)
except subprocess.TimeoutExpired:
    p.kill()

print("\nProduced files:")
for f in sorted(OUTDIR.rglob("*")):
    if f.is_file():
        print(" ", f.relative_to(OUTDIR), f"{f.stat().st_size/1024:.0f} KB")
