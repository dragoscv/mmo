#!/usr/bin/env bash
# Build .deb / .rpm / .AppImage on the Ubuntu VM as a smoke test.
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
echo papuci123 | $SSH 'sudo -S apt-get install -y -qq rpm fakeroot libarchive-tools 2>&1 | tail -3'
$SSH 'cd /home/dragos/companion-dev && pkill -f "companion-dev/.*electron" 2>/dev/null; sleep 1; rm -rf release; ./node_modules/.bin/electron-builder --linux --x64 2>&1 | tail -40; echo ===ARTIFACTS===; ls -lh release/ 2>&1'
