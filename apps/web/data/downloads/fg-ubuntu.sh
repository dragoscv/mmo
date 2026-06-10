#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
$SSH 'export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/$(id -u); export PULSE_SERVER=unix:/run/user/$(id -u)/pulse/native; cd /home/dragos/companion-dev && timeout 10 ./node_modules/.bin/electron --no-sandbox dist/main.js 2>&1 | head -60'
