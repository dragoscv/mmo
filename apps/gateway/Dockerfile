# MuzicAI Gateway — Hono control plane on Cloud Run.
# Multi-stage: build bundle with tsup, then ship a slim runtime image with
# only production node_modules (ws, postgres, hono, @hono/node-server).

FROM node:22-slim AS build
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN pnpm build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN npm install -g pnpm@10
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod --frozen-lockfile=false && pnpm store prune
COPY --from=build /app/dist ./dist
EXPOSE 8080
ENV PORT=8080
CMD ["node", "dist/server.js"]
