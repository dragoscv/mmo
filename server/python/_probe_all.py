"""Smoke-probe all engine sidecars, mirroring per-engine python routing
from server/src/voice/engines.ts. Verifies install state matches what
the companion will see at runtime.
"""
import json, subprocess, sys, pathlib

HERE = pathlib.Path(__file__).parent
BASE_PY = sys.executable

# Mirror ENGINES from engines.ts. Keep in sync when adding engines.
ENGINES = [
    {"script": "demucs_sidecar.py", "python": BASE_PY},
    {"script": "rvc_sidecar.py", "python": BASE_PY},
    {"script": "ace_step_sidecar.py", "python": str(HERE / ".venvs" / "ace_step" / "Scripts" / "python.exe")},
    {"script": "fish_speech_sidecar.py", "python": str(HERE / ".venvs" / "fish_speech" / "Scripts" / "python.exe")},
]

for e in ENGINES:
    py = e["python"] if pathlib.Path(e["python"]).exists() else BASE_PY
    note = "" if py == e["python"] else " (venv missing, fell back to base)"
    p = subprocess.Popen([py, str(HERE / e["script"])],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         text=True, encoding="utf-8")
    evt = json.loads(p.stdout.readline())
    print(f"{e['script']:28s} installed={evt['installed']!s:5s} caps={evt['capabilities']} hint={evt.get('installHint')}{note}")
    p.kill()
