#!/usr/bin/env bash
# Startup script of a MixAI cloud E2E VM (launched by scripts/e2e-cloud/run.mjs).
# Runs on brivio's runner image (Node, pnpm/corepack, Playwright browsers in /opt/ms-playwright).
# Contract — everything under gs://<bucket>/mmo/runs/<id>/:
#   in:  src.tgz (working tree), env (KEY=VALUE lines; deleted from the bucket right after read)
#   out: log (streamed every 15 s), report.tgz, results.tgz, server-logs.tgz, meta.json,
#        exit-code (written LAST)
# The VM deletes itself in the EXIT trap; --max-run-duration + termination DELETE is the backstop.
set -uo pipefail

md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
attr() { md "attributes/$1" 2>/dev/null || true; }

RUN_ID="$(attr run-id)"
BUCKET="$(attr bucket)"
MODE="$(attr mode)"                       # remote | vm-prod
BASE_URL="$(attr base-url | base64 -d)"
PW_ARGS="$(attr pw-args | base64 -d)"
CMD="$(attr cmd | base64 -d)"
KEEP="$(attr keep)"
NAME="$(md name)"
ZONE="$(md zone | awk -F/ '{print $NF}')"
RUN="gs://${BUCKET}/mmo/runs/${RUN_ID}"
W=/home/runner/work
WEB="$W/apps/web"
LOG=/var/log/mmo-e2e.log
T0=$(date +%s)
: > "$LOG"; chmod 644 "$LOG"
exec > >(tee -a "$LOG") 2>&1

phase() { echo "::phase $1 $(( $(date +%s) - T0 ))s"; }

finish() {
  local code=$?
  [ -f /tmp/pw-exit ] && code="$(cat /tmp/pw-exit)"
  phase "done exit=$code"
  # Never `kill 0`: that signals the whole process group, i.e. this trap itself.
  for p in "${SYNC_PID:-}" "${SERVER_PID:-}" "${FWD_PID:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  if cd "$WEB" 2>/dev/null; then
    [ -d playwright-report ] && tar -czf /tmp/report.tgz playwright-report && gcloud storage cp -q /tmp/report.tgz "$RUN/report.tgz"
    [ -f pw-results.json ] && mkdir -p test-results && cp pw-results.json test-results/pw-results.json
    [ -d test-results ] && tar -czf /tmp/results.tgz test-results && gcloud storage cp -q /tmp/results.tgz "$RUN/results.tgz"
  fi
  # next start + forwarder logs: a page that rendered the error boundary is undiagnosable once the VM is gone.
  LOGS="$(cd /tmp && ls next.log fwd.log build.log build-webpack.log 2>/dev/null | tr '\n' ' ')"
  if [ -n "$LOGS" ]; then
    # shellcheck disable=SC2086
    tar -czf /tmp/server-logs.tgz -C /tmp $LOGS && gcloud storage cp -q /tmp/server-logs.tgz "$RUN/server-logs.tgz" || true
  fi
  printf '{"runId":"%s","machine":"%s","zone":"%s","mode":"%s","seconds":%s,"phases":"%s","exit":%s}\n' \
    "$RUN_ID" "$(md machine-type | awk -F/ '{print $NF}')" "$ZONE" "$MODE" "$(( $(date +%s) - T0 ))" \
    "$(grep -o '::phase [a-z-]* [0-9]*s' "$LOG" | awk '{print $2"="$3}' | paste -sd, -)" "$code" > /tmp/meta.json
  gcloud storage cp -q /tmp/meta.json "$RUN/meta.json"
  gcloud storage cp -q "$LOG" "$RUN/log"
  echo "$code" > /tmp/exit-code && gcloud storage cp -q /tmp/exit-code "$RUN/exit-code"
  [ "$KEEP" != "1" ] && gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet --delete-disks=all
}
trap finish EXIT

( while sleep 15; do gcloud storage cp -q "$LOG" "$RUN/log" 2>/dev/null; done ) &
SYNC_PID=$!

phase boot
mkdir -p "$W" && cd "$W"
gcloud storage cp -q "$RUN/src.tgz" /tmp/src.tgz && tar -xzf /tmp/src.tgz -C "$W" || exit 1
# The env object carries secrets (DB URL, AUTH_SECRET, session token): read once, delete everywhere.
if gcloud storage cp -q "$RUN/env" /tmp/run.env 2>/dev/null; then
  set -a; . /tmp/run.env; set +a
  gcloud storage rm -q "$RUN/env" || true
  echo "env keys: $(cut -d= -f1 /tmp/run.env | paste -sd, -)"
  rm -f /tmp/run.env
fi
chown -R runner:runner "$W"
phase fetched

export TZ=Europe/Bucharest CI=1 MMO_E2E_CLOUD=1 PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
export NEXT_TELEMETRY_DISABLED=1 HUSKY=0 SKIP_ENV_VALIDATION=1
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# json reporter → file (outside test-results/, which Playwright wipes at start); finish() copies it in.
export PLAYWRIGHT_JSON_OUTPUT_NAME="$WEB/pw-results.json"
as_runner() { sudo -u runner -H --preserve-env bash -lc "export PATH=\$HOME/.local/bin:\$PATH; cd $W && $1"; }

# Root package.json pins pnpm via packageManager, but sub-dirs without that field (apps/web, packages/*)
# fall back to corepack's DEFAULT — on the image that is pnpm 12, which ignores package.json
# `pnpm.overrides` and fails the frozen install (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH). Make the root pin the default.
# Corepack's shim still re-dispatched to the image pnpm during install (run 2611050721-dq8w), so use a
# private npm-installed binary first on PATH and turn pnpm's own version switching off.
PNPM_VER="$(node -p "(require('$W/package.json').packageManager || 'pnpm@10.0.0').split('@')[1].split('+')[0]" 2>/dev/null)"
as_runner "npm i -g --silent --prefix \$HOME/.pnpm-pin pnpm@$PNPM_VER >/dev/null 2>&1" || exit 1
as_runner() { sudo -u runner -H --preserve-env bash -lc "export PATH=\$HOME/.pnpm-pin/bin:\$HOME/.local/bin:\$PATH npm_config_manage_package_manager_versions=false; cd $W && $1"; }
as_runner "cd apps/web && echo \"pnpm \$(pnpm --version) at \$(command -v pnpm), node \$(node --version)\""
as_runner "pnpm config set store-dir /home/runner/.pnpm-store" || true
# Per-app lockfiles (shared-workspace-lockfile=false): web + every package web consumes via tsconfig paths.
INST_FAIL=0
for d in apps/web packages/*; do
  [ -f "$W/$d/pnpm-lock.yaml" ] || continue
  as_runner "cd $d && pnpm install --frozen-lockfile --ignore-workspace --prefer-offline --reporter=silent" > "/tmp/install-$(basename "$d").log" 2>&1 &
done
for j in $(jobs -p); do [ "$j" = "$SYNC_PID" ] && continue; wait "$j" || INST_FAIL=1; done
tail -n 3 /tmp/install-*.log
if [ "$INST_FAIL" = "1" ]; then echo "✗ an install failed"; tail -n 40 /tmp/install-*.log; exit 1; fi
as_runner "cd apps/web && pnpm exec playwright install chromium" || exit 1
phase install

if [ -n "${COMPANION_TUNNEL_URL:-}" ]; then
  # The paired device row points at http://127.0.0.1:17899 → forward that port to the workstation's companion.
  nohup node "$W/scripts/e2e-cloud/companion-forward.mjs" > /tmp/fwd.log 2>&1 &
  FWD_PID=$!
  ok=0
  for _ in $(seq 1 30); do
    if curl -fsS -m 10 -o /dev/null http://127.0.0.1:17899/health; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = "1" ] && echo "companion via tunnel: $(curl -fsS -m 10 http://127.0.0.1:17899/health)" || { echo "✗ companion unreachable through the tunnel"; cat /tmp/fwd.log; exit 1; }
  phase companion
fi

if [ "$MODE" = "vm-prod" ]; then
  as_runner "cd apps/web && NODE_OPTIONS=--max-old-space-size=12288 pnpm build" > /tmp/build.log 2>&1
  rc=$?
  if [ "$rc" != "0" ]; then
    # Turbopack's next/font/google replacer died on the VM (run 2611050731-vsx2: "next/font/google queries
    # have exactly one entry", module-not-found on the font files). build:webpack is the repo's sanctioned fallback.
    echo "✗ turbopack build failed ($rc) — first error lines:"; grep -m 12 -iE 'error|failed|not found' /tmp/build.log
    phase build-turbo-failed
    as_runner "cd apps/web && rm -rf .next && NODE_OPTIONS=--max-old-space-size=12288 pnpm build:webpack" > /tmp/build-webpack.log 2>&1
    rc=$?; tail -n 30 /tmp/build-webpack.log
    [ "$rc" = "0" ] || { echo "✗ webpack build failed too ($rc)"; exit 1; }
    echo "built with: webpack (fallback)"
  else
    tail -n 15 /tmp/build.log; echo "built with: turbopack"
  fi
  phase build
  as_runner "cd apps/web && nohup pnpm exec next start -p 13789 > /tmp/next.log 2>&1 &"
  for _ in $(seq 1 90); do curl -fsS -o /dev/null http://127.0.0.1:13789/api/health && break; sleep 2; done
  curl -fsS -m 10 http://127.0.0.1:13789/api/health || { echo "✗ next start not healthy"; tail -n 60 /tmp/next.log; exit 1; }
  echo
  # 127.0.0.1, not localhost: playwright.config only spawns `pnpm dev` for http://localhost URLs.
  export PLAYWRIGHT_BASE_URL=http://127.0.0.1:13789
  phase server
else
  export PLAYWRIGHT_BASE_URL="$BASE_URL"
fi

phase tests
if [ -n "$CMD" ]; then
  as_runner "cd apps/web && $CMD"; echo $? > /tmp/pw-exit
else
  as_runner "cd apps/web && pnpm exec playwright test $PW_ARGS"; echo $? > /tmp/pw-exit
fi
exit 0
