/**
 * MuzicAI companion gateway — Hono on Cloud Run.
 *
 * Routes:
 *   GET  /health                      → liveness (NOT /healthz — reserved by GFE)
 *   POST /api/devices/announce        → companion heartbeat + command channel
 *   WS   /ws                          → persistent heartbeat + command channel
 *
 * Shares DATABASE_URL + AUTH_SECRET with the web app. Stateless; safe to
 * scale horizontally (WS liveness is per-instance but DB lastSeenAt is the
 * source of truth the web app reads).
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { handleAnnounce } from "./routes/announce.js";
import { attachUpgradeHandler, createCompanionWss } from "./ws/hub.js";

const app = new Hono();

app.use("*", logger());
app.use("/api/*", cors({
    origin: (process.env.CORS_ALLOW_ORIGINS ?? "https://muzicai.ro").split(",").map((s) => s.trim()),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86_400,
}));

app.get("/health", (c) => c.json({ ok: true, service: "muzicai-gateway", ts: Date.now() }));
app.get("/", (c) => c.text("muzicai-gateway"));

app.post("/api/devices/announce", handleAnnounce);

const port = Number(process.env.PORT ?? 8080);

const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[gateway] listening on :${info.port}`);
});

// Wire the WebSocket upgrade onto the same HTTP server.
const wss = createCompanionWss();
// @hono/node-server exposes the underlying http.Server via the return value.
(server as unknown as import("node:http").Server).on("upgrade", attachUpgradeHandler(wss, "/ws"));

function shutdown(sig: string) {
    console.log(`[gateway] ${sig} received, shutting down`);
    wss.close();
    (server as unknown as import("node:http").Server).close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
