#!/usr/bin/env bash
set -e
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10022 dragos@127.0.0.1"
$SSH 'export PATH=/Users/dragos/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; cd /Users/dragos/companion-dev; pkill -f "companion-dev/node_modules/electron" 2>/dev/null; sleep 1; ELECTRON_VER=$(node -p "require(\"./node_modules/electron/package.json\").version"); echo "electron version: $ELECTRON_VER"; ./node_modules/.bin/electron-rebuild -v $ELECTRON_VER -f -w better-sqlite3 -w audify 2>&1 | tail -40; echo "----DONE----"'
