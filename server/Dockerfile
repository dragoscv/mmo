# syntax=docker/dockerfile:1.7
# MMO Server — headless Node core (ADR-0002). Multi-arch: linux/amd64, linux/arm64.
# Build context = server/ (own pnpm-lock.yaml). Always build LOCALLY (docker
# buildx + QEMU for arm64) — never on the Raspberry Pi:
#   pwsh scripts/build-mmo-server-image.ps1    # local, measured, both arches
#   pwsh scripts/deploy-mmo-server-pi.ps1      # ship the arm64 image to homepi
#
# Size/speed (measured 2026-09-17; before: 2.13 GB, ~6 min building on the Pi):
#   * pnpm store + apt lists live in BuildKit cache mounts → warm rebuilds skip
#     the network entirely.
#   * ffmpeg = BtbN GPL *shared* build (n8.1: bin/ffmpeg, bin/ffprobe + lib/)
#     fetched per TARGETARCH — ~120 MB vs 327 MB for the two static binaries
#     (each bundles every codec) and vs 459 MB for Debian's ffmpeg (LLVM, mesa…).
#     ffmpeg-static/ffprobe-static (336 MB of every-platform binaries) and audify
#     (Electron-only native audio) are removed from node_modules; @types,
#     typescript, docs and tests pruned.
#   * runtime = node:22-bookworm-slim + tini + 2 static binaries.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- ffmpeg (static, per arch) ----------
FROM --platform=$BUILDPLATFORM debian:bookworm-slim AS ffmpeg
ARG TARGETARCH
ARG FFMPEG_TAG=n8.1
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils
RUN --mount=type=cache,id=ffmpeg-dl,target=/dl \
    set -eu; \
    case "$TARGETARCH" in amd64) a=linux64;; arm64) a=linuxarm64;; *) echo "unsupported $TARGETARCH"; exit 1;; esac; \
     f="ffmpeg-${FFMPEG_TAG}-latest-${a}-gpl-shared-${FFMPEG_TAG#n}.tar.xz"; \
    [ -f "/dl/$f" ] || curl -fsSL -o "/dl/$f" "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$f"; \
     mkdir -p /out && tar -xJf "/dl/$f" -C /out --strip-components=1 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe' '*/lib/*.so*' \
 && rm -rf /out/lib/pkgconfig && du -sh /out

# ---------- deps + build ----------
FROM ${NODE_IMAGE} AS build
ARG PNPM_VERSION=10.0.0
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    CI=1
# NOTE: no npm_config_build_from_source — better-sqlite3 >= 13 is N-API and
# ships linux-{x64,arm64} prebuilds INSIDE the npm tarball (no download step);
# audify still uses prebuild-install. Compiling better-sqlite3 under QEMU took
# 15 of the 21 minutes of the first arm64 build.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=prebuilds,target=/root/.npm/_prebuilds \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build \
 && pnpm prune --prod --config.ignore-scripts=true \
 && rm -rf node_modules/ffmpeg-static node_modules/ffprobe-static node_modules/audify \
           node_modules/@types node_modules/typescript node_modules/.cache \
 && find node_modules -type d \( -name test -o -name tests -o -name docs -o -name example -o -name examples -o -name .github \) -prune -exec rm -rf {} + \
 && find node_modules -type f \( -name '*.md' -o -name '*.map' -o -name 'CHANGELOG*' \) -delete \
 && du -sh node_modules

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates wget \
 && rm -rf /usr/share/doc /usr/share/man /usr/share/locale
COPY --from=ffmpeg /out/bin/ /usr/local/bin/
COPY --from=ffmpeg /out/lib/ /usr/local/lib/
ENV LD_LIBRARY_PATH=/usr/local/lib
ENV NODE_ENV=production \
    MMO_HEADLESS=1 \
    MMO_DATA=/data \
    MMO_PORT=17899 \
    FFMPEG_PATH=/usr/local/bin/ffmpeg \
    FFPROBE_PATH=/usr/local/bin/ffprobe
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node python ./python
RUN mkdir -p /data /media && chown node:node /data /media
USER node
VOLUME ["/data", "/media"]
EXPOSE 17899
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${MMO_PORT}/health >/dev/null || exit 1
ENTRYPOINT ["tini", "--", "node", "dist/headless.js"]
