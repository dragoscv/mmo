#!/usr/bin/env bash
set -e
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
$SSH 'cd /home/dragos/companion-dev && touch node_modules/.installed && ./node_modules/.bin/tsc 2>&1 | tail -20 && echo ==BUILT== && ls dist/main.js && echo ==REBUILD== && ./node_modules/.bin/electron-rebuild -f -w better-sqlite3 -w audify 2>&1 | tail -10 && touch node_modules/.electron-rebuilt && echo ==DONE=='
