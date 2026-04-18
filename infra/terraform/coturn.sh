#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# coturn auto-configure on boot.
#
# Reads the TURN secret + realm from instance metadata and writes a hardened
# turnserver.conf using the RFC "ephemeral REST" auth pattern.  Clients fetch
# time-limited credentials from the Next.js app, which mints them as:
#
#   username = <unix-expiry>:<user-id>
#   password = base64(HMAC-SHA1(secret, username))
#
# coturn validates by recomputing the HMAC — no per-user state on the server.
# ─────────────────────────────────────────────────────────────────────────────
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y coturn curl

META="http://metadata.google.internal/computeMetadata/v1"
HEADER="Metadata-Flavor: Google"

EXTERNAL_IP=$(curl -fsS -H "$HEADER" "$META/instance/network-interfaces/0/access-configs/0/external-ip")
INTERNAL_IP=$(curl -fsS -H "$HEADER" "$META/instance/network-interfaces/0/ip")
TURN_SECRET=$(curl -fsS -H "$HEADER" "$META/instance/attributes/turn-secret")
TURN_REALM=$(curl -fsS -H "$HEADER" "$META/instance/attributes/turn-realm")

cat > /etc/turnserver.conf <<EOF
# ── Listening ───────────────────────────────────────────────────────────────
listening-port=3478
listening-ip=${INTERNAL_IP}
relay-ip=${INTERNAL_IP}
external-ip=${EXTERNAL_IP}/${INTERNAL_IP}

# ── Relay port range (must match firewall) ──────────────────────────────────
min-port=49160
max-port=49200

# ── Auth: ephemeral REST shared-secret ──────────────────────────────────────
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${TURN_REALM}

# ── Quotas / safety ─────────────────────────────────────────────────────────
total-quota=100
user-quota=12
bps-capacity=0
stale-nonce=600
no-multicast-peers
no-cli
no-loopback-peers
no-tlsv1
no-tlsv1_1

# ── Logging ─────────────────────────────────────────────────────────────────
log-file=/var/log/turnserver/turnserver.log
simple-log
EOF

mkdir -p /var/log/turnserver
chown turnserver:turnserver /var/log/turnserver

# Enable the service (Debian package ships disabled by default)
echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn
systemctl enable coturn
systemctl restart coturn

echo "coturn provisioned. external-ip=${EXTERNAL_IP} realm=${TURN_REALM}"
