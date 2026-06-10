#!/usr/bin/env bash
# Poll the latest workflow run for v0.9.11
TAG=v0.9.11
while true; do
  curl -sf "https://api.github.com/repos/dragoscv/mmo/actions/runs?per_page=5" > /tmp/runs.json
  STATE=$(python3 -c "
import json
runs = json.load(open('/tmp/runs.json'))['workflow_runs']
for r in runs:
    if r['head_branch'] == '$TAG' or '$TAG' in r['display_title']:
        print(r['status'], r['conclusion'] or 'in_progress', r['html_url'])
        break
")
  if [ -z "$STATE" ]; then
    echo "[$(date +%H:%M:%S)] no run yet for $TAG, waiting..."
  else
    echo "[$(date +%H:%M:%S)] $STATE"
    case "$STATE" in
      "completed success"*) exit 0 ;;
      "completed failure"*) exit 1 ;;
      "completed cancelled"*) exit 2 ;;
    esac
  fi
  sleep 30
done
