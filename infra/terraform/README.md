# MMO TURN/STUN infrastructure (Terraform / GCP)

A single self-managed [coturn](https://github.com/coturn/coturn) instance that
provides STUN + TURN for the WebRTC audio bridge.  Required because public STUN
alone fails behind symmetric NATs (most mobile carriers).

## What gets created

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

Then add to `app/.env.local`:

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
