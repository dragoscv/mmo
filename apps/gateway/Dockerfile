# MuzicAI Gateway — Hono control plane on Cloud Run.
#
# The bundle is built locally by deploy.ps1 (tsup bundles @mmo/db from the
# monorepo, which isn't in this build context). The image ships the prebuilt
# dist + production runtime deps (ws, postgres, hono, @hono/node-server).

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile=false && pnpm store prune
COPY dist ./dist
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/server.js"]
