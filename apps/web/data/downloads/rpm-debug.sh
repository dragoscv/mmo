#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
$SSH 'cd /home/dragos/companion-dev && rm -rf release && DEBUG="electron-builder" ./node_modules/.bin/electron-builder --linux rpm --x64 2>&1 | tail -80'
