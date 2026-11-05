#!/bin/sh
# Looping "live" demo channel: stream-copies one legal film into a rolling HLS playlist forever.
# No re-encode (-c copy). Usage: loop.sh <input file> <out dir>   (runs in the mmo-server image: ffmpeg + node)
set -eu
IN="$1"; OUT="$2"
mkdir -p "$OUT"
while true; do
  rm -f "$OUT"/*.ts "$OUT"/index.m3u8
  date +%s > "$OUT/started"
  ffmpeg -hide_banner -loglevel warning -re -stream_loop -1 -i "$IN" \
    -map 0:v:0 -map 0:a:0 -c copy \
    -f hls -hls_time 6 -hls_list_size 10 \
    -hls_flags delete_segments+omit_endlist+program_date_time+independent_segments \
    -hls_segment_filename "$OUT/seg-%06d.ts" "$OUT/index.m3u8" || true
  sleep 2
done
