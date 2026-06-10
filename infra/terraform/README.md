# MMO infrastructure (Terraform / GCP)

Two stacks live here:

1. **TURN/STUN** (`main.tf`, `coturn.sh`) — coturn VM for the WebRTC remote bridge.
2. **Database & storage** (`database.tf`) — Cloud SQL Postgres + GCS bucket + Secret Manager.

## TURN/STUN — coturn

A single self-managed [coturn](https://github.com/coturn/coturn) instance that
provides STUN + TURN for the WebRTC audio bridge.  Required because public STUN
alone fails behind symmetric NATs (most mobile carriers).

### What gets created

| Resource | Cost (europe-west1) |
|---|---|
| `e2-micro` VM, Debian 12, 10 GB pd-standard | ~$6.11/mo |
| Static external IPv4 | ~$1.46/mo (only when **detached** — free while attached to running VM) |
| Egress traffic | $0.12/GB to internet (~$0.011/hour of relayed audio @ 96 kbps) |
| **Total idle** | **≈ $6/mo** |

Capacity: ~150 concurrent audio relays per e2-micro.  Bump to `e2-small` if you
need more, or move to TURN-as-a-service later (Cloudflare Calls, Xirsys,
Metered) without changing app code.

## Deploy

Prerequisites: `terraform >= 1.12`, `gcloud` authenticated as a user with
`compute.admin` + `serviceusage.admin` on the target project.

```pwsh
cd infra/terraform
terraform init
terraform apply -var="project_id=mmo-mw-prod"
```

After ~2 minutes the apply finishes and prints:

```
turn_host          = "34.X.Y.Z:3478"
turn_realm         = "mmo.local"
turn_shared_secret = <sensitive>
ssh_command        = "gcloud compute ssh mmo-turn ..."
```

Reveal the secret with:

```pwsh
terraform output -raw turn_shared_secret
```

Then add to `apps/web/.env.local`:

```
TURN_HOST=34.X.Y.Z:3478
TURN_SHARED_SECRET=<paste>
TURN_REALM=mmo.local
```

## Validate

From any machine with `turnutils_uclient` (ships with coturn-utils):

```pwsh
turnutils_uclient -v -t -u test -w <secret> -r mmo.local 34.X.Y.Z
```

…or open the app, connect remote, and watch the **ICE** column flip from
`checking` → `connected`.  When TURN relays are used, the `Up`/`Down` kbps in
the live stats will be non-zero even when the two peers can't reach each other
directly.

## Operational

```pwsh
# SSH (uses IAP — no public SSH port)
gcloud compute ssh mmo-turn --zone=europe-west1-b --tunnel-through-iap

# Tail logs
sudo tail -f /var/log/turnserver/turnserver.log

# Restart after config change
sudo systemctl restart coturn
```

## Tear down

```pwsh
terraform destroy
```

Removes everything; static IP is released.

## Future hardening

- **TURNS (TLS) on 5349**: requires a domain name → A record → certbot.  The
  startup script already opens the port placeholder; uncomment the
  `tls-listening-port`, `cert`, `pkey` lines once you have a cert.
- **Dual-stack**: add IPv6 with `google_compute_address.ip_version = "IPV6"`.
- **Auto-update**: cron `unattended-upgrades` is enabled by default on Debian 12.

---

## Database & storage — Cloud SQL Postgres + GCS

Cloud SQL `mmo-pg` (POSTGRES_16, `db-f1-micro`, ~$10/mo + $0.17/GB storage) is
the source-of-truth for app metadata. The companion app keeps a local SQLite
cache and owns the actual audio files.

GCS bucket `mmo-user-files-prod` holds anything the user explicitly uploads
(recording exports, avatars, artwork) — never the raw library tracks.

### Resources (declared in `database.tf`)

| Resource | Cost |
|---|---|
| Cloud SQL `db-f1-micro` POSTGRES_16, 10GB HDD, daily backup | ~$10/mo + $0.10/GB-month |
| GCS bucket `STANDARD` europe-west1 | $0.020/GB-month + egress |
| Secret Manager (2 secrets) | first 6 versions free |
| Service account `mmo-web-app` | free |

### First-time import (resources were created via gcloud first)

```pwsh
cd infra/terraform
terraform init

# Import existing infra into state — adjust project ID
terraform import google_sql_database_instance.mmo projects/mmo-mw-prod/instances/mmo-pg
terraform import google_sql_database.mmo projects/mmo-mw-prod/instances/mmo-pg/databases/mmo
terraform import google_sql_user.postgres projects/mmo-mw-prod/instances/mmo-pg/postgres
terraform import google_storage_bucket.user_files mmo-user-files-prod
terraform import google_secret_manager_secret.db_url projects/mmo-mw-prod/secrets/mmo-database-url
terraform import google_secret_manager_secret.db_password projects/mmo-mw-prod/secrets/mmo-postgres-password
terraform import google_project_service.sqladmin mmo-mw-prod/sqladmin.googleapis.com
terraform import google_project_service.secretmanager mmo-mw-prod/secretmanager.googleapis.com
terraform import google_project_service.storage mmo-mw-prod/storage.googleapis.com

terraform plan
```

After the plan is clean (only random_password and the SA + key need creating),
`terraform apply`. The DB password in Terraform will then become the source of
truth — rotate it in `random_password` then re-apply.

### Reading secrets

```pwsh
# DATABASE_URL (paste into apps/web/.env.local and Vercel env)
gcloud secrets versions access latest --secret=mmo-database-url

# Service account JSON key (post-apply)
terraform output -raw web_app_sa_key_json | base64 -d > mmo-web-app-sa.json
```

Put the SA key JSON into Vercel as a single env var (base64-encoded):

```pwsh
$json = terraform output -raw web_app_sa_key_json
vercel env add GCP_SERVICE_ACCOUNT_KEY production
# paste $json (it's already base64)
```

### Open SQL connection from local dev

The instance is `--require-ssl` and authorized for `0.0.0.0/0`. Use a strong
password (already done) and connect:

```pwsh
psql "postgres://postgres:PASSWORD@34.79.95.212:5432/mmo?sslmode=require"
```

For long-lived dev sessions, use the Cloud SQL Auth Proxy instead:

```pwsh
cloud-sql-proxy mmo-mw-prod:europe-west1:mmo-pg --port 5432
psql "postgres://postgres:PASSWORD@127.0.0.1:5432/mmo"
```

### Tear-down protection

`google_sql_database_instance.mmo` has `deletion_protection = true`. To remove
the instance you must first set it to false, apply, then destroy.
