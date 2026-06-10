#!/bin/bash
APP="/Applications/MMO Companion.app"

echo "-- killing prior --"
pgrep -fl "MMO Companion" | awk '{print $1}' | xargs -I{} kill -9 {} 2>/dev/null || true
sleep 2

echo "-- removing old logs --"
rm -rf "$HOME/Library/Logs/MMO Companion" 2>/dev/null
rm -f /tmp/mmo-stdout.log /tmp/mmo-stderr.log

echo "-- launch with safe-mode flags --"
"$APP/Contents/MacOS/MMO Companion" \
    --disable-gpu \
    --disable-gpu-compositing \
    --disable-software-rasterizer \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-features=UseChromeOSDirectVideoDecoder,VaapiVideoDecodeLinuxGL \
    >/tmp/mmo-stdout.log 2>/tmp/mmo-stderr.log &
APPPID=$!
echo "PID=$APPPID"

for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    sleep 2
    PORT_OK=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -c ':17899')
    HELPERS=$(pgrep -fl "MMO Companion Helper" | wc -l | tr -d ' ')
    echo "[$i*2s] helpers=$HELPERS port17899_listening=$PORT_OK"
    if [ "$PORT_OK" -gt 0 ]; then
        echo "PORT BOUND!"
        break
    fi
done

echo ""
echo "---ALL PROCS---"
pgrep -fl "MMO Companion" | head
echo ""
echo "---ALL PORTS---"
lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | head -20
echo ""
echo "---STDERR (last 80)---"
tail -80 /tmp/mmo-stderr.log
echo ""
echo "---STDOUT (last 40)---"
tail -40 /tmp/mmo-stdout.log
echo ""
echo "---MAIN.LOG---"
LOGFILE="$HOME/Library/Logs/MMO Companion/main.log"
[ -f "$LOGFILE" ] && tail -40 "$LOGFILE" || echo "(no main.log)"
echo ""
echo "---HEALTH---"
curl -sS --max-time 5 http://127.0.0.1:17899/health 2>&1 | head -10
