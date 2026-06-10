#!/usr/bin/env bash
set -e
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10022 dragos@127.0.0.1"
$SSH 'export PATH=/Users/dragos/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin; cd /Users/dragos/companion-dev; echo "==INSTALL=="; echo papuci123 | sudo -S installer -pkg assets/virtual-audio/macos/BlackHole.16ch.pkg -target / 2>&1 | tail -20; echo "==KICKSTART=="; sudo launchctl kickstart -k system/com.apple.audio.coreaudiod 2>&1; sleep 2; echo "==HAL=="; ls -la /Library/Audio/Plug-Ins/HAL/ 2>&1; echo "==PROBE AFTER=="; node test-va.js 2>&1 | head -1; echo "==SYSTEM_PROFILER=="; system_profiler SPAudioDataType 2>/dev/null | grep -A2 -i blackhole | head -20'
