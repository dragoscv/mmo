"""Companion plugin host (VST3 / AU / LV2 via Spotify's pedalboard).

Architecture
------------
- Pedalboard ships native plugin hosting (built on JUCE) as a Python
  library. We piggy-back on the same long-running NDJSON sidecar used
  by the analyzer (analyze.py) — opcodes prefixed with `plugins.*`.
- Plugin discovery is filesystem-scan based: walk the OS-standard
  directories, attempt `pedalboard.load_plugin()`, capture metadata
  and parameter list, cache to a JSON file in the user data dir so
  subsequent boots don't re-scan from scratch.
- Rendering is **offline**. The web client uploads (or references) a
  WAV; we run it through a chain (each step = plugin path + param
  overrides) and write the result. The web layer streams the output
  WAV back via the existing /library/stems-style range-aware route.
- Realtime (WS chunked) is intentionally out of scope for this first
  cut — latency over HTTP is too high; web apps that need realtime
  effects keep using WebAudio nodes (Mixer, Live monitor path).

Cross-platform notes
--------------------
- Windows: VST3 only (AU is macOS-exclusive by design). Plugin paths:
    %CommonProgramFiles%\\VST3
    %ProgramFiles%\\Common Files\\VST3
    %LOCALAPPDATA%\\Programs\\Common\\VST3
- macOS:   VST3 + AU (~/Library/Audio/Plug-Ins/{VST3,Components})
- Linux:   VST3 + LV2

Wire format
-----------
Same NDJSON line-delimited protocol the analyzer uses:
  → { id, kind: "plugins.scan", paths?: string[] }
  → { id, kind: "plugins.list" }
  → { id, kind: "plugins.describe", path: str }
  → { id, kind: "plugins.render", input: str, output: str,
      chain: [{ path: str, params: {name: value} }] }
  ← { id, kind: "result", ok: bool, data?: any, error?: str }

Each long-running scan also emits progress lines:
  ← { id, kind: "progress", stage: "plugins", pct: 0..1, msg: str }
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any


# ─── Lazy imports ────────────────────────────────────────────────────


def _try_pedalboard():
    try:
        import pedalboard  # type: ignore
        return pedalboard
    except Exception:
        return None


# ─── Plugin discovery paths ──────────────────────────────────────────


def _default_plugin_paths() -> list[str]:
    """OS-standard install directories. Users can extend via the
    `paths` request field; we de-dup before scanning."""
    paths: list[str] = []
    if sys.platform == "win32":
        for env in ("CommonProgramFiles", "ProgramFiles", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if not base:
                continue
            paths.append(os.path.join(base, "VST3"))
            paths.append(os.path.join(base, "Common Files", "VST3"))
        paths.append(r"C:\Program Files\Common Files\VST3")
    elif sys.platform == "darwin":
        home = str(Path.home())
        paths.extend([
            "/Library/Audio/Plug-Ins/VST3",
            os.path.join(home, "Library/Audio/Plug-Ins/VST3"),
            "/Library/Audio/Plug-Ins/Components",
            os.path.join(home, "Library/Audio/Plug-Ins/Components"),
        ])
    else:
        # Linux LV2 + VST3
        home = str(Path.home())
        paths.extend([
            "/usr/lib/vst3",
            "/usr/local/lib/vst3",
            os.path.join(home, ".vst3"),
            "/usr/lib/lv2",
            "/usr/local/lib/lv2",
            os.path.join(home, ".lv2"),
        ])
    # De-dup, preserve order, drop missing.
    seen: set[str] = set()
    out: list[str] = []
    for p in paths:
        np = os.path.normcase(os.path.abspath(p))
        if np in seen:
            continue
        seen.add(np)
        if os.path.isdir(p):
            out.append(p)
    return out


def _is_plugin_file(name: str) -> bool:
    lower = name.lower()
    return lower.endswith(".vst3") or lower.endswith(".component") or lower.endswith(".lv2")


def _walk_plugins(root: str) -> list[str]:
    """Find every .vst3/.component/.lv2 bundle under `root`. These are
    bundles/dirs on macOS and Linux, but also dirs on Windows (VST3
    bundles). pedalboard.load_plugin handles each correctly."""
    out: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        for d in list(dirnames):
            if _is_plugin_file(d):
                out.append(os.path.join(dirpath, d))
                dirnames.remove(d)  # don't recurse into the bundle
        for f in filenames:
            if _is_plugin_file(f):
                out.append(os.path.join(dirpath, f))
    return out


# ─── Parameter introspection ─────────────────────────────────────────


def _describe_parameters(plugin: Any) -> list[dict[str, Any]]:
    """Pull a JSON-serializable parameter list from a loaded plugin.

    pedalboard exposes parameters as Python attributes whose names
    we can introspect via the `parameters` dict (newer versions) or
    via the `_parameters` private mapping. Each parameter has:
      - `name`           (string)
      - `label`          (units, e.g. "Hz")
      - `min_value`/`max_value`/`step_size`/`type` (when continuous)
      - `valid_values`   (when discrete)
      - `string_value`   (current value formatted as displayed)
      - `raw_value`      (0..1 normalized, the most portable form)
    """
    params: list[dict[str, Any]] = []
    try:
        param_map = getattr(plugin, "parameters", None)
        if not param_map:
            return params
        # `parameters` is an OrderedDict on recent pedalboard versions.
        for key, p in param_map.items():
            entry: dict[str, Any] = {"id": key, "name": getattr(p, "name", key)}
            for attr in ("label", "type", "min_value", "max_value", "step_size",
                         "valid_values", "string_value", "raw_value", "default_raw_value"):
                if hasattr(p, attr):
                    try:
                        v = getattr(p, attr)
                        # JSON-friendly coercion
                        if v is None:
                            entry[attr] = None
                        elif isinstance(v, (str, int, float, bool)):
                            entry[attr] = v
                        elif isinstance(v, (list, tuple)):
                            entry[attr] = [str(x) for x in v]
                        else:
                            entry[attr] = str(v)
                    except Exception:
                        pass
            params.append(entry)
    except Exception:
        pass
    return params


# ─── Public API: scan / describe / render ────────────────────────────


def cmd_scan(req: dict, emit_progress) -> dict:
    """Walk plugin directories and try to load every candidate.
    Returns the (cached) inventory after this scan completes."""
    pb = _try_pedalboard()
    if pb is None:
        raise RuntimeError(
            "pedalboard not installed — `pip install pedalboard`")
    extra = req.get("paths") or []
    roots = list(dict.fromkeys(_default_plugin_paths() + list(extra)))
    candidates: list[str] = []
    for r in roots:
        candidates.extend(_walk_plugins(r))
    # De-dup paths.
    seen: set[str] = set()
    uniq: list[str] = []
    for c in candidates:
        np = os.path.normcase(os.path.abspath(c))
        if np in seen:
            continue
        seen.add(np)
        uniq.append(c)
    inventory: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    total = max(1, len(uniq))
    for i, path in enumerate(uniq):
        emit_progress(
            "plugins", i / total,
            f"Probing {os.path.basename(path)} ({i + 1}/{total})…")
        try:
            plugin = pb.load_plugin(path)
            entry = {
                "path": path,
                "name": getattr(plugin, "name", os.path.basename(path)),
                "manufacturer": getattr(plugin, "manufacturer_name", "") or "",
                "format": _guess_format(path),
                "isInstrument": _is_instrument(plugin),
                "isEffect": not _is_instrument(plugin),
                "parameters": _describe_parameters(plugin),
            }
            inventory.append(entry)
            # Free the GUI / DSP graph eagerly — scanning hundreds of
            # plugins otherwise leaks audio threads on Windows.
            try:
                del plugin
            except Exception:
                pass
        except Exception as e:
            failures.append({"path": path, "error": str(e)[:200]})
    emit_progress("plugins", 1.0, f"Scan complete — {len(inventory)} plugin(s)")
    return {
        "scannedAt": time.time(),
        "inventory": inventory,
        "failures": failures,
        "roots": roots,
    }


def cmd_describe(req: dict, _emit_progress) -> dict:
    """Load a single plugin and return its parameter manifest. Used
    when the web UI opens a plugin's editor view."""
    pb = _try_pedalboard()
    if pb is None:
        raise RuntimeError("pedalboard not installed")
    path = req["path"]
    plugin = pb.load_plugin(path)
    return {
        "path": path,
        "name": getattr(plugin, "name", os.path.basename(path)),
        "manufacturer": getattr(plugin, "manufacturer_name", "") or "",
        "format": _guess_format(path),
        "parameters": _describe_parameters(plugin),
        "isInstrument": _is_instrument(plugin),
    }


def cmd_render(req: dict, emit_progress) -> dict:
    """Run an audio file through a chain of plugins, write the result.

    Request:
        input  : absolute path to source WAV/FLAC/MP3
        output : absolute path to write (must be writable)
        chain  : [{ path: str, params?: {param_id: value} }]

    Returns:
        { ok, output, durationSec, sampleRate, channels }
    """
    pb = _try_pedalboard()
    if pb is None:
        raise RuntimeError("pedalboard not installed")
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore

    src = req["input"]
    dst = req["output"]
    chain_spec = req.get("chain") or []
    if not chain_spec:
        raise ValueError("chain must contain at least one plugin step")

    emit_progress("render", 0.05, "Loading audio…")
    data, sr = sf.read(src, always_2d=True)
    # pedalboard expects float32 (n_samples, n_channels) — soundfile
    # gives us that already, but we coerce dtype for safety.
    audio = np.asarray(data, dtype="float32")

    emit_progress("render", 0.15, f"Loading {len(chain_spec)} plugin(s)…")
    plugins: list[Any] = []
    for step in chain_spec:
        p = pb.load_plugin(step["path"])
        params = step.get("params") or {}
        for key, val in params.items():
            try:
                # `parameters` exposes a settable proxy; we can also
                # set raw_value (0..1) for portability across hosts.
                if hasattr(p, "parameters") and key in p.parameters:
                    setattr(p, key, val)
                else:
                    # Try direct attribute (older pedalboard versions)
                    setattr(p, key, val)
            except Exception:
                # Skip unsettable params — better partial than aborting.
                pass
        plugins.append(p)

    emit_progress("render", 0.30, "Processing…")
    board = pb.Pedalboard(plugins)
    out = board(audio, sample_rate=sr)
    emit_progress("render", 0.85, "Writing output…")
    # Ensure parent dir exists.
    os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
    # `out` is float32 in same shape; write 24-bit PCM for fidelity.
    sf.write(dst, out, sr, subtype="PCM_24")
    emit_progress("render", 1.0, "Done")
    return {
        "ok": True,
        "output": dst,
        "durationSec": float(out.shape[0] / sr),
        "sampleRate": int(sr),
        "channels": int(out.shape[1]) if out.ndim > 1 else 1,
    }


# ─── Helpers ─────────────────────────────────────────────────────────


def _guess_format(path: str) -> str:
    lower = path.lower()
    if lower.endswith(".vst3"):
        return "VST3"
    if lower.endswith(".component"):
        return "AU"
    if lower.endswith(".lv2"):
        return "LV2"
    return "?"


def _is_instrument(plugin: Any) -> bool:
    """Pedalboard exposes `is_instrument` on most VST3 wrappers; fall
    back to checking `accepts_midi`/`midi_input`."""
    for attr in ("is_instrument", "accepts_midi", "has_midi_input"):
        try:
            v = getattr(plugin, attr, None)
            if v is True:
                return True
        except Exception:
            pass
    return False


# ─── Public exports ──────────────────────────────────────────────────


COMMANDS = {
    "plugins.scan": cmd_scan,
    "plugins.describe": cmd_describe,
    "plugins.render": cmd_render,
}


def has_pedalboard() -> bool:
    return _try_pedalboard() is not None


if __name__ == "__main__":
    # Manual-test harness: `python plugins.py scan` walks the OS dirs
    # and prints the inventory as JSON.
    if len(sys.argv) > 1 and sys.argv[1] == "scan":
        def _p(stage, pct, msg):
            print(f"[{stage}] {pct * 100:5.1f}% — {msg}", file=sys.stderr)
        out = cmd_scan({}, _p)
        print(json.dumps(out, indent=2))
