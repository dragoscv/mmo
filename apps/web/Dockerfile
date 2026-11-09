# MixAI web (apps/web, Next 16 standalone) → Cloud Run `mixai-web` (europe-west1).
# Build context = REPO ROOT (apps/web consumes packages/* through tsconfig paths, and
# `prebuild` copies docs/ into learn-content). The deploy script stages the context with
# `git archive HEAD -- apps/web packages docs …` so only committed files ship, and drops
# public/samples (934 MB of DAW audio — served from GCS later, not from the image).
#   pwsh -NoProfile -File apps/web/scripts/deploy-cloud-run.ps1   (via deploy-clean.ps1)
# glibc base on purpose: the lockfile carries linux-x64-gnu natives (next swc, lightningcss,
# sharp); engines = node 22.x.

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------- deps: one frozen install per lockfile (per-app lockfiles, no shared workspace) ----------
FROM ${NODE_IMAGE} AS deps
ENV npm_config_manage_package_manager_versions=false \
    NEXT_TELEMETRY_DISABLED=1
# Root pin (package.json packageManager). Settings/overrides/allowBuilds live in each project's
# pnpm-workspace.yaml (pnpm 11+ ignores .npmrc settings and package.json#pnpm).
RUN npm i -g pnpm@12.18.0 && pnpm --version
WORKDIR /repo
COPY package.json pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml apps/web/
COPY packages/ai/package.json packages/ai/pnpm-lock.yaml packages/ai/pnpm-workspace.yaml packages/ai/
COPY packages/ai-mcp/package.json packages/ai-mcp/pnpm-lock.yaml packages/ai-mcp/pnpm-workspace.yaml packages/ai-mcp/
COPY packages/audio-gen/package.json packages/audio-gen/pnpm-lock.yaml packages/audio-gen/pnpm-workspace.yaml packages/audio-gen/
COPY packages/db/package.json packages/db/pnpm-lock.yaml packages/db/pnpm-workspace.yaml packages/db/
COPY packages/design-tokens/package.json packages/design-tokens/pnpm-lock.yaml packages/design-tokens/pnpm-workspace.yaml packages/design-tokens/
COPY packages/sdk/package.json packages/sdk/pnpm-lock.yaml packages/sdk/pnpm-workspace.yaml packages/sdk/
COPY packages/ui/package.json packages/ui/pnpm-lock.yaml packages/ui/pnpm-workspace.yaml packages/ui/
RUN set -eu; \
    for d in apps/web packages/ai packages/ai-mcp packages/audio-gen packages/db packages/design-tokens packages/sdk packages/ui; do \
      echo "== install $d"; \
      (cd "$d" && pnpm install --frozen-lockfile --reporter=append-only); \
    done

# ---------- build ----------
FROM deps AS build
COPY apps/web apps/web
COPY packages packages
COPY docs docs
# Build-time placeholders only: route modules are imported while collecting page data
# (db/index.ts throws without DATABASE_URL; lib/env.ts refuses a production boot without
# AUTH_*). No connection is opened at build time. Real values come from Secret Manager at runtime.
ENV NODE_ENV=production \
    NEXT_OUTPUT_STANDALONE=1 \
    SKIP_ENV_VALIDATION=1 \
    NODE_OPTIONS=--max-old-space-size=6144 \
    DATABASE_URL=postgres://build:build@127.0.0.1:5432/build \
    AUTH_SECRET=build-time-placeholder-not-used-at-runtime-0000 \
    AUTH_GOOGLE_ID=build-placeholder \
    AUTH_GOOGLE_SECRET=build-placeholder
WORKDIR /repo/apps/web
RUN pnpm build

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runner
ARG COMMIT_SHA=unknown
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080 \
    HOSTNAME=0.0.0.0 \
    COMMIT_SHA=${COMMIT_SHA}
WORKDIR /app
# outputFileTracingRoot = repo root → server lives at apps/web/server.js inside standalone.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /repo/apps/web/learn-content ./apps/web/learn-content
USER node
WORKDIR /app/apps/web
EXPOSE 8080
CMD ["node", "server.js"]
