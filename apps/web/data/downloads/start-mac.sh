#!/usr/bin/env bash
set -e
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10022 dragos@127.0.0.1"
$SSH 'export PATH=/Users/dragos/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; cd /Users/dragos/companion-dev; node --version; ls -lh dist/main.js; rm -f /tmp/companion-dev.log; nohup ./node_modules/.bin/electron dist/main.js >/tmp/companion-dev.log 2>&1 </dev/null & disown; sleep 10; tail -150 /tmp/companion-dev.log; echo "----PROC----"; ps -axo pid,command | grep -i companion-dev | grep -v grep | head'
