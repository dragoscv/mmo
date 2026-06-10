#!/usr/bin/env bash
SSH="sshpass -p papuci123 ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p 10024 dragos@127.0.0.1"
$SSH 'export DISPLAY=:0; export XDG_RUNTIME_DIR=/run/user/$(id -u); xhost +SI:localuser:dragos 2>/dev/null || true; xhost +local: 2>/dev/null || true; ls -la ~/.Xauthority 2>&1; loginctl list-sessions --no-legend 2>&1; ps -eo pid,user,cmd | grep -E "Xorg|Xwayland|gnome-session|gdm" | grep -v grep | head'
