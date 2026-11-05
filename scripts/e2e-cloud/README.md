# Cloud E2E (`pnpm e2e:cloud`)

Browser tests never run on the workstation (owner rule). `run.mjs` ships the **working tree** to an
ephemeral GCE **spot** VM, runs Playwright there and brings the report back. Port of brivio
`scripts/e2e-cloud` (ADR-0236) on brivio's runner infrastructure.

| Piece | Value |
|---|---|
| GCP project | `brivio-488003` (override `MMO_E2E_PROJECT`) |
| Image family | `brivio-e2e-runner` (Node, corepack, Playwright browsers in `/opt/ms-playwright`) |
| Service account | `brivio-e2e-runner@brivio-488003.iam.gserviceaccount.com` — may delete only `brivio-e2e-*` VMs |
| VM name | `brivio-e2e-mmo-<runId>`, zone `europe-central2-a`, default `n2d-standard-16` |
| Bucket | `gs://brivio-e2e-runs-brivio-488003/mmo/runs/<runId>/` (`src.tgz`, `env`, `log`, `report.tgz`, `results.tgz`, `server-logs.tgz`, `meta.json`, `exit-code`) |
| Backstops | `--provisioning-model=SPOT --instance-termination-action=DELETE --max-run-duration=2h`; the VM deletes itself in its EXIT trap |

## Usage

```powershell
# a deployed origin (remote mode: no build on the VM)
pnpm e2e:cloud --target https://mixai.ro e2e/media-wp16.spec.ts --project=chromium

# build apps/web on the VM (next build + next start :13789), signed in against the real stack
pnpm e2e:cloud --target vm-prod --prod-session --companion-tunnel --out .copilot-tmp/e2e-wp16/out e2e/media-wp16.spec.ts --project=chromium --workers=2

pnpm e2e:cloud --attach <runId>     # re-follow a run
pnpm e2e:cloud --ledger             # cost ledger (.copilot-tmp/e2e-cloud/ledger.jsonl)
```

Everything that is not a harness flag is passed to `playwright test` (cwd `apps/web`). Reporters
default to `list,html,json`; the JSON lands in `test-results/pw-results.json`. Report, results and the
VM's `next.log` / `fwd.log` / `build.log` land in `--out` (default `apps/web`).

### Signed-in runs

- `--prod-session` inserts ONE `session` row (2 h) into the database `apps/web/.env.local` points at
  (**production**) for the user owning the local companion's device row, passes it as
  `E2E_SESSION_COOKIE`, and deletes it in a `finally` (prints `deleted sessions: N`).
- `--companion-tunnel` checks `http://127.0.0.1:17899/health`; when the MMO Server is down it starts
  `scripts/run-companion-local.ps1` (and stops it afterwards). It opens a Cloudflare quick tunnel
  (`cloudflared tunnel --url http://localhost:17899`) for the run's lifetime. On the VM
  `companion-forward.mjs` listens on `127.0.0.1:17899` and forwards HTTP + WebSocket to the tunnel, so
  the paired device row keeps its loopback `api_url` — **nothing is written to `devices`**. The Host
  header becomes the tunnel host, so the companion's loopback-only public routes stay closed.

### Env shipped to the VM (`vm-prod`)

A whitelist, never `.env.local` wholesale: `DATABASE_URL`, `AUTH_SECRET` (session lookup + device-token
decryption), plus `COMPANION_TUNNEL_URL` / `E2E_SESSION_COOKIE` when those flags are used. The key names
are printed on launch and on the VM; values never are. The VM deletes the `env` object as soon as it
has read it; the launcher deletes it again in `finally` in case the VM never booted.

## Cost

Spot `n2d-standard-16` ≈ 0.18 USD/h list price. The ledger counts seconds from the startup script on;
VM creation (~2 min) is extra. Measured: install of web + 7 packages 11 s (parallel, warm image store).
A full WP16 run (build + 7 tests) is expected at ~15–25 min → ≈ 0.05–0.08 USD.

## Known blocker (2026-11-05)

`next build` (Turbopack) fails on the VM: `Module not found: Can't resolve
'@vercel/turbopack-next/internal/font/google/font'` / `next/font/google queries have exactly one entry`
for the fonts in `apps/web/src/app/layout.tsx` (same tree builds on the workstation). The harness then
tries `build:webpack`, which fails on a real app bug (`node:crypto` in a client import chain). Server
logs of every run land in `<out>/server-logs/`.

## Cleanup / checks

```powershell
gcloud compute instances list --project brivio-488003 --filter='name~brivio-e2e-mmo'   # must be empty after a run
gcloud compute instances delete <name> --zone europe-central2-a --project brivio-488003   # only if a run was killed with --keep
```

The `finally` (session delete, tunnel stop, companion stop) runs on every normal exit, including a failed
run. If the launcher process itself is killed, the session row simply expires after 2 h; stop a leftover
tunnel with `Get-Process cloudflared | Stop-Process`.
