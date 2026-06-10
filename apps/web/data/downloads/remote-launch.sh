#!/usr/bin/env bash
# Remote-side launcher executed on the Ubuntu VM
set +e
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DISPLAY=:0
XAUTH=$(ls /run/user/$(id -u)/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
export XAUTHORITY=$XAUTH
export PULSE_SERVER=unix:/run/user/$(id -u)/pulse/native
export WAYLAND_DISPLAY=wayland-0
echo "[launcher] XAUTH=$XAUTH"
echo "[launcher] DISPLAY=$DISPLAY"
echo "[launcher] PULSE_SERVER=$PULSE_SERVER"
cd /home/dragos/companion-dev
pkill -f "companion-dev/.*electron" 2>/dev/null
sleep 1
rm -f /tmp/companion-dev.log
echo "[launcher] launching electron"
nohup ./node_modules/.bin/electron \
  --no-sandbox \
  --enable-features=UseOzonePlatform \
  --ozone-platform=x11 \
  dist/main.js >/tmp/companion-dev.log 2>&1 </dev/null &
disown
sleep 8
echo "==LOG=="
tail -120 /tmp/companion-dev.log 2>&1
echo "==PROC=="
pgrep -af "/electron" | head
echo "==PORT=="
ss -tlnp 2>/dev/null | grep 17899 || echo "(17899 not bound)"
