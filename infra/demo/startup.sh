#!/bin/bash
# GCE startup script for mixai-demo (runs as root on every boot; idempotent).
# Mounts the data disk at /srv/mixai, installs Docker CE + compose plugin, wires AR auth and the EPG cron.
set -euo pipefail
exec > >(tee -a /var/log/mixai-startup.log) 2>&1
echo "== startup $(date -Is)"

DEV=/dev/disk/by-id/google-mixai-data
MNT=/srv/mixai
if ! blkid "$DEV" >/dev/null 2>&1; then
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard -L mixai-data "$DEV"
fi
mkdir -p "$MNT"
grep -q "LABEL=mixai-data" /etc/fstab || echo "LABEL=mixai-data $MNT ext4 discard,defaults,nofail 0 2" >> /etc/fstab
mountpoint -q "$MNT" || mount "$MNT"
mkdir -p "$MNT"/{media/films,media/shows,media/music,data,channel/www,caddy/data,caddy/config,app}
chown 1000:1000 "$MNT/media" "$MNT/media/films" "$MNT/media/shows" "$MNT/media/music"
chown -R 1000:1000 "$MNT/data" "$MNT/channel"

if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg unzip jq
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
command -v unzip >/dev/null 2>&1 || apt-get install -y unzip jq

# 2 GB RAM: a small swap file keeps scans/ffprobe from OOM-killing the server.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile
fi
swapon --show | grep -q /swapfile || swapon /swapfile
grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab

gcloud auth configure-docker europe-west1-docker.pkg.dev --quiet >/dev/null 2>&1 || true

if [ -f "$MNT/app/compose.yaml" ] && [ -f "$MNT/app/.env" ]; then
  cd "$MNT/app" && docker compose up -d || true
fi
echo "== startup done $(date -Is)"
