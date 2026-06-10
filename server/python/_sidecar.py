"""Shared NDJSON sidecar protocol for MMO Python engines.

All engine sidecars (voice_clone.py, rvc.py, ace_step.py, demucs.py,
fish_speech.py, …) talk to the companion using the same stdio
protocol. This module factors out the boilerplate so each engine file
focuses on its own model code.

Protocol
────────
  ← hello   { kind: "hello", engineId, version, capabilities, device, … }
  →         { id, kind, …args }
  ← progress { id, kind: "progress", stage, pct, msg }
  ← result  { id, kind: "result", ok: true,  data: {…} }
            { id, kind: "result", ok: false, error: "…" }

Usage
─────
    from _sidecar import Sidecar

    sc = Sidecar(engine_id="demucs", version="1.0", capabilities=["separate"])

    @sc.handler("separate")
    def _on_separate(job):
        sc.progress(job["id"], "load", 0.1)
        ...
        return {"stems": [...]}   # auto-wrapped as result/ok

    sc.run()
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, Callable

# Force UTF-8 on stdio so non-ASCII (ă, ș, ț, é, ñ, 中, …) survives the
# NDJSON hop on Windows where the default codepage is cp1252.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# Capture the real stdout for protocol writes, then redirect sys.stdout
# to stderr so noisy libraries (demucs download bars, transformers
# logging, print() debugging in pretrained models) can't corrupt the
# NDJSON stream. All protocol output must go through `_PROTOCOL_OUT`.
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr


def detect_device() -> dict:
    """Return {type, name?, vramGb?} describing the inference device."""
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


def has_module(name: str) -> bool:
    """Cheap import-availability probe. Does NOT actually import the
    module (so we don't pay the heavy import cost just for `hello`)."""
    import importlib.util
    return importlib.util.find_spec(name) is not None


class Sidecar:
    def __init__(
        self,
        *,
        engine_id: str,
        version: str = "0.1",
        capabilities: list[str] | None = None,
        extra_hello: dict | None = None,
    ) -> None:
        self.engine_id = engine_id
        self.version = version
        self.capabilities = capabilities or []
        self.extra_hello = extra_hello or {}
        self._handlers: dict[str, Callable[[dict], Any]] = {}

        # Built-in ping for liveness checks.
        self.handler("ping")(lambda _j: {"pong": True})

    # ─── Registration ──────────────────────────────────────────────

    def handler(self, kind: str) -> Callable[[Callable[[dict], Any]], Callable[[dict], Any]]:
        """Decorator. The wrapped function receives the full job dict
        (including `id`) and returns either:
          • a dict           → wrapped as {kind:result, ok:true, data:<dict>}
          • None             → wrapped as {kind:result, ok:true, data:{}}
          • a Sidecar.Async  → caller has already sent its own result
        Exceptions are caught and emitted as {ok:false, error:str(exc)}."""
        def deco(fn: Callable[[dict], Any]) -> Callable[[dict], Any]:
            self._handlers[kind] = fn
            return fn
        return deco

    # ─── Wire emit helpers ─────────────────────────────────────────

    def emit(self, payload: dict) -> None:
        _PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
        _PROTOCOL_OUT.flush()

    def progress(self, job_id: str, stage: str, pct: float, msg: str = "") -> None:
        self.emit({"id": job_id, "kind": "progress", "stage": stage, "pct": float(pct), "msg": msg})

    def result(self, job_id: str, ok: bool, data: dict | None = None, error: str | None = None) -> None:
        payload: dict[str, Any] = {"id": job_id, "kind": "result", "ok": ok}
        if data is not None:
            payload["data"] = data
        if error is not None:
            payload["error"] = error
        self.emit(payload)

    # Marker returned by handlers that have already emitted their own
    # result (e.g. streaming jobs). Tells `_dispatch` to skip auto-wrap.
    class Async:
        pass

    ASYNC = Async()

    # Per-call context handed to handlers. Carries the job id and a
    # bound progress helper so handlers don't need a reference to the
    # whole Sidecar instance just to report progress.
    class Ctx:
        def __init__(self, sc: "Sidecar", job_id: str) -> None:
            self._sc = sc
            self.job_id = job_id

        def progress(self, stage: str, pct: float, msg: str = "") -> None:
            self._sc.progress(self.job_id, stage, pct, msg)

        def emit(self, payload: dict) -> None:
            # Lets streaming handlers push raw events; they must set
            # `id` themselves and return Sidecar.ASYNC.
            self._sc.emit(payload)

    # ─── Run loop ──────────────────────────────────────────────────

    def hello(self) -> dict:
        payload: dict[str, Any] = {
            "kind": "hello",
            "engineId": self.engine_id,
            "version": self.version,
            "capabilities": self.capabilities,
            "device": detect_device(),
            "pid": os.getpid(),
        }
        payload.update(self.extra_hello)
        return payload

    def _dispatch(self, job: dict) -> None:
        kind = job.get("kind")
        job_id = job.get("id") or "0"
        fn = self._handlers.get(str(kind) if kind else "")
        if fn is None:
            self.result(job_id, False, error=f"unknown-kind: {kind}")
            return
        try:
            args = job.get("args") or {}
            if not isinstance(args, dict):
                args = {}
            ctx = Sidecar.Ctx(self, job_id)
            out = fn(args, ctx)
            if out is self.ASYNC:
                return
            self.result(job_id, True, data=out or {})
        except Exception as exc:  # noqa: BLE001
            self.result(job_id, False, error=f"{type(exc).__name__}: {exc}\n{traceback.format_exc()[:1500]}")

    def run(self) -> None:
        self.emit(self.hello())
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                job = json.loads(line)
            except json.JSONDecodeError as exc:
                self.emit({"kind": "error", "error": f"bad-json: {exc}"})
                continue
            self._dispatch(job)
