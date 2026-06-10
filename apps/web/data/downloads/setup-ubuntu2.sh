#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
$SSH 'echo papuci123 | sudo -S apt-get install -y -qq pulseaudio-utils libxshmfence1 libgbm1 libxss1 build-essential python3 rsync libsecret-1-0 libnotify4 2>&1 | tail -5; echo ==PACTL==; pactl --version | head -1; pactl info 2>&1 | head -8'
