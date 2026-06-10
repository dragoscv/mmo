"""Live monitor/control side-channel for the ACE-Step trainer.

Imported by `train.py`. Spawns:
  • A control-poller thread that GETs /api/training/control/<jobId> every
    POLL_EVERY seconds and acts on the returned patch (pause / earlyStop /
    learningRate logging / evalNow flag).
  • A stdout-tailer that parses upstream trainer output and POSTs step /
    loss events to /api/training/webhook with rate-limiting.

Control limitations we acknowledge openly:
  • Learning-rate / dataset-weight patches are RECORDED but not actually
    applied mid-run because the upstream `acestep.cli.train` CLI does not
    expose a hot-reload hook. Maestro is told this in the system prompt
    and the dashboard surfaces the patch event so the user knows it will
    apply on the next run.
  • `pause` is implemented via SIGSTOP / SIGCONT on the subprocess.
  • `earlyStop` is implemented via SIGTERM; the trainer's preemption-safe
    checkpointing covers the rest.
  • `evalNow` toggles an in-memory flag that the trainer would need to
    poll; today it's purely advisory.
"""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from urllib import error as urlerror, request as urlrequest

POLL_EVERY = float(os.environ.get("TRAINER_CONTROL_POLL_SEC", "10"))
EVENT_FLUSH_EVERY = float(os.environ.get("TRAINER_EVENT_FLUSH_SEC", "5"))
EVENT_FLUSH_MAX_BATCH = int(os.environ.get("TRAINER_EVENT_FLUSH_MAX", "20"))

# Heuristic regex patterns for typical ACE-Step / HuggingFace trainer
# stdout lines. Order matters — first match wins.
_STEP_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bstep[\s=:]+(?P<step>\d+)\b.*?\bloss[\s=:]+(?P<loss>[\d.eE+-]+)"),
    re.compile(r"'loss':\s*(?P<loss>[\d.eE+-]+).*'step':\s*(?P<step>\d+)"),
    re.compile(r"\b(?P<step>\d+)/\d+\b.*?\bloss\s*[=:]\s*(?P<loss>[\d.eE+-]+)"),
]


@dataclass
class TrainerMonitor:
    job_id: str
    webhook_url: str
    control_url: str
    secret: str
    process_ref: dict[str, subprocess.Popen[bytes] | None] = field(default_factory=lambda: {"proc": None})
    _queue: queue.Queue[dict[str, Any]] = field(default_factory=queue.Queue)
    _stop: threading.Event = field(default_factory=threading.Event)
    _control_state: dict[str, Any] = field(default_factory=dict)
    _last_step_posted: int = -1

    # ────────────────────────────────────────────────────────────────────
    # Webhook helpers

    def _post_event(self, body: dict[str, Any]) -> None:
        body = {**body, "jobId": self.job_id}
        data = json.dumps(body).encode("utf-8")
        req = urlrequest.Request(
            self.webhook_url,
            data=data,
            method="POST",
            headers={
                "content-type": "application/json",
                "x-mmo-trainer-secret": self.secret,
            },
        )
        try:
            with urlrequest.urlopen(req, timeout=10):
                pass
        except urlerror.URLError as e:
            print(f"[monitor] webhook POST failed: {e}", flush=True)

    def emit(self, **event: Any) -> None:
        """Queue an event for batched delivery."""
        self._queue.put(event)

    def _flush_loop(self) -> None:
        while not self._stop.is_set():
            batch: list[dict[str, Any]] = []
            try:
                first = self._queue.get(timeout=EVENT_FLUSH_EVERY)
                batch.append(first)
            except queue.Empty:
                continue
            while len(batch) < EVENT_FLUSH_MAX_BATCH:
                try:
                    batch.append(self._queue.get_nowait())
                except queue.Empty:
                    break
            for ev in batch:
                self._post_event(ev)

    # ────────────────────────────────────────────────────────────────────
    # Control polling

    def _poll_control(self) -> None:
        while not self._stop.is_set():
            time.sleep(POLL_EVERY)
            try:
                req = urlrequest.Request(
                    self.control_url,
                    method="GET",
                    headers={"x-mmo-trainer-secret": self.secret},
                )
                with urlrequest.urlopen(req, timeout=10) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
            except Exception as e:  # noqa: BLE001
                print(f"[monitor] control poll failed: {e}", flush=True)
                continue
            self._apply_control(payload)

    def _apply_control(self, payload: dict[str, Any]) -> None:
        # The endpoint returns the control_signal payload directly.
        if not isinstance(payload, dict):
            return
        prev = self._control_state
        self._control_state = payload

        # pause / resume
        if payload.get("pause") and not prev.get("pause"):
            self._signal_proc(signal.SIGSTOP)
            self.emit(kind="warning", message="Paused by control signal")
        elif prev.get("pause") and not payload.get("pause"):
            self._signal_proc(signal.SIGCONT)
            self.emit(kind="warning", message="Resumed by control signal")

        # earlyStop → SIGTERM (trainer's resume-from-checkpoint covers loss)
        if payload.get("earlyStop"):
            self.emit(kind="warning", message="Early stop requested — sending SIGTERM")
            self._signal_proc(signal.SIGTERM)

        # learningRate / datasetItemWeights — log as a controlPatch event so
        # the dashboard records it. Not applied mid-run (see module docstring).
        patch_keys = {"learningRate", "datasetItemWeights", "evalPrompt"}
        recorded = {k: payload[k] for k in patch_keys if k in payload}
        if recorded and recorded != {k: prev.get(k) for k in recorded}:
            self.emit(
                kind="controlPatch",
                message=f"Patch recorded (next-run): {json.dumps(recorded)}",
                data=recorded,
            )

        # evalNow advisory — log only; the trainer subprocess would need to
        # cooperate to actually render a sample mid-training.
        if payload.get("evalNow") and not prev.get("evalNow"):
            self.emit(kind="warning", message="evalNow flag observed (advisory)")

    def _signal_proc(self, sig: int) -> None:
        proc = self.process_ref.get("proc")
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.send_signal(sig)
        except OSError as e:
            print(f"[monitor] signal {sig} failed: {e}", flush=True)

    # ────────────────────────────────────────────────────────────────────
    # Stdout tailer

    def consume_stdout_line(self, line: str) -> None:
        """Parse one trainer stdout line and emit a step event when matched."""
        line = line.rstrip()
        for pat in _STEP_PATTERNS:
            m = pat.search(line)
            if not m:
                continue
            try:
                step = int(m.group("step"))
                loss = float(m.group("loss"))
            except (ValueError, IndexError):
                continue
            # Rate-limit: skip duplicates, only emit when step advanced.
            if step <= self._last_step_posted:
                return
            self._last_step_posted = step
            self.emit(kind="step", step=step, loss=loss)
            return
        # Pass through interesting non-step lines as warnings (sparingly).
        lowered = line.lower()
        if "error" in lowered or "traceback" in lowered:
            self.emit(kind="warning", message=line[:500])

    # ────────────────────────────────────────────────────────────────────
    # Lifecycle

    def start(self) -> None:
        threading.Thread(target=self._flush_loop, daemon=True, name="monitor-flush").start()
        threading.Thread(target=self._poll_control, daemon=True, name="monitor-control").start()

    def stop(self) -> None:
        self._stop.set()
        # Drain the queue best-effort.
        while True:
            try:
                ev = self._queue.get_nowait()
            except queue.Empty:
                break
            self._post_event(ev)
