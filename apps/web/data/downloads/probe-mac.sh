#!/usr/bin/env bash
set -e
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10022 dragos@127.0.0.1"
$SSH 'export PATH=/Users/dragos/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; tail -200 /tmp/companion-dev.log; echo "----HAL----"; ls /Library/Audio/Plug-Ins/HAL/ 2>&1; echo "----ASSETS----"; ls -lh /Users/dragos/companion-dev/assets/virtual-audio/macos/ 2>&1'
