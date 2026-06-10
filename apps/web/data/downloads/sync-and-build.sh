#!/usr/bin/env bash
set -e
cd /mnt/e/gh/rekordbox-mwrty/server
echo "[sync] package.json"
tar -czf - package.json | sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1 'cd /home/dragos/companion-dev && tar -xzf -'
echo "[build] electron-builder --linux --x64"
sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1 'cd /home/dragos/companion-dev && pkill -f electron 2>/dev/null; sleep 1; rm -rf release; ./node_modules/.bin/electron-builder --linux --x64 2>&1 | tail -60; echo "===ART==="; ls -lh release/'
