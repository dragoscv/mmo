#!/usr/bin/env bash
echo "==SINKS=="
pactl list short sinks | grep MMO || echo "(no MMO sinks visible to host)"
echo "==CLEANUP=="
pkill -f mmo-companion 2>/dev/null
sleep 2
for s in MMO-Master MMO-Cue MMO-Aux1 MMO-Aux2 MMO-Loopback; do
  mid=$(pactl list short modules | grep "sink_name=$s" | awk '{print $1}')
  if [ -n "$mid" ]; then
    pactl unload-module "$mid" 2>/dev/null
  fi
done
pactl list short sinks | grep MMO || echo "all MMO sinks removed"
