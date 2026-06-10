#!/usr/bin/env bash
set -e

echo "==CLEANUP=="
pkill -9 -f mmo-companion 2>/dev/null || true
sleep 2

echo "==LAUNCH=="
export DISPLAY=:0
export WAYLAND_DISPLAY=wayland-0
export XDG_RUNTIME_DIR=/mnt/wslg/runtime-dir
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
rm -f /tmp/mmo-companion.log
nohup '/opt/MMO Companion/mmo-companion' >/tmp/mmo-companion.log 2>&1 </dev/null &
disown

echo "==WAIT=="
for i in $(seq 1 20); do
  sleep 2
  if ss -tnlp 2>/dev/null | grep -q 17899; then
    echo "  port 17899 up after ${i}x2s"
    break
  fi
done

echo "==HEALTH=="
curl -sf -m 5 http://127.0.0.1:17899/health
echo

echo "==LOG (filtered)=="
grep -v -E 'ALSA|viz_main|gl_display|GpuMemoryBuffer|gpu_init|electron_helper|EGL' /tmp/mmo-companion.log | tail -30

echo "==PROC=="
ps -axo pid,command | grep -i 'mmo-companion' | grep -v grep | head -5

echo "==SINKS via host pactl=="
pactl list short sinks 2>&1 | grep MMO || echo "(no MMO sinks visible to host pactl)"
