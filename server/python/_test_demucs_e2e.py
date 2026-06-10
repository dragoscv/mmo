"""End-to-end smoke test: drive demucs_sidecar via NDJSON, separate one file."""
import json, subprocess, sys, os, time, pathlib

SCRIPT = pathlib.Path(__file__).parent / "demucs_sidecar.py"
INPUT = r"e:\gh\mmo\app\data\generated\d1131c8f-b384-43e3-8487-a8d9e9a823e0\ea54265d-27b0-4d04-a0dd-9babb6a4d240.wav"
OUTDIR = r"e:\gh\mmo\server\python\_test_stems"
os.makedirs(OUTDIR, exist_ok=True)

p = subprocess.Popen([sys.executable, str(SCRIPT)],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=subprocess.PIPE, text=True, encoding='utf-8', bufsize=1)

hello = json.loads(p.stdout.readline())
print("HELLO:", hello["engineId"], "installed=", hello["installed"], "device=", hello["device"]["type"])
assert hello["installed"], "demucs not installed"

req = {"id": "t1", "kind": "demucs.separate",
       "args": {"inputPath": INPUT, "outputDir": OUTDIR, "model": "htdemucs", "twoStems": False}}
print("SEND:", req)
p.stdin.write(json.dumps(req) + "\n"); p.stdin.flush()

t0 = time.time()
while True:
    line = p.stdout.readline()
    if not line: break
    evt = json.loads(line)
    print(f"  [+{time.time()-t0:5.1f}s]", evt.get("kind"), {k:v for k,v in evt.items() if k not in ("kind","id")})
    if evt.get("kind") == "result":
        break

p.stdin.close()
err = p.stderr.read()
if err.strip(): print("STDERR:", err[:500])
p.wait(timeout=10)
print("\nProduced files:")
for f in sorted(pathlib.Path(OUTDIR).rglob("*")):
    if f.is_file(): print(" ", f.relative_to(OUTDIR), f"{f.stat().st_size/1024:.0f} KB")
