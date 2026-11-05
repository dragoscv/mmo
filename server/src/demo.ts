/**
 * Public demo mode (`MMO_DEMO=1`) — the store-review server at demo.mixai.ro (WP16-53).
 *
 * Anyone can pair (Quick Connect requests are approved automatically, see
 * pair/router.ts), so every remote client holds the device token. This guard
 * keeps such clients to what a viewer does: browse, play, progress, watchlist,
 * Watch Together, favourites. Library/folder/source/profile administration and
 * filesystem/log reads answer 403 for them.
 *
 * "Admin" = a loopback connection WITHOUT `x-forwarded-for`: the reverse proxy
 * (Caddy, same host) always adds that header, so only commands run on the VM
 * itself (`curl http://127.0.0.1:17899/...`) manage the server.
 */

import type express from "express";

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.MMO_DEMO === "1";
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Mutations a reviewer's app needs. Everything else that mutates is admin-only. */
const VIEWER_WRITES: ReadonlyArray<[string, RegExp]> = [
    ["POST", /^\/pair\/request$/],
    ["POST", /^\/media\/profiles\/[^/]+\/unlock$/],
    ["PUT", /^\/media\/watchlist\/[^/]+\/[^/]+$/],
    ["DELETE", /^\/media\/watchlist\/[^/]+\/[^/]+$/],
    ["PUT", /^\/media\/progress$/],
    ["POST", /^\/media\/plays$/],
    ["POST", /^\/media\/bookmarks$/],
    ["DELETE", /^\/media\/bookmarks\/[^/]+$/],
    ["PUT", /^\/media\/music\/queue$/],
    ["POST", /^\/video\/scan$/],
    ["POST", /^\/video\/stream\/[^/]+\/pause$/],
    ["POST", /^\/video\/audio-tracks\/[^/]+\/extract$/],
    ["POST", /^\/video\/party\/create$/],
    ["PUT", /^\/livetv\/channels\/[^/]+\/favourite$/],
    ["DELETE", /^\/livetv\/channels\/[^/]+\/favourite$/],
    ["POST", /^\/hub\/rooms$/],
    ["POST", /^\/hub\/command$/],
    ["POST", /^\/cast\/(play|command)$/],
];

/** Reads that expose the host rather than the library. */
const ADMIN_READS: ReadonlyArray<RegExp> = [
    /^\/fs(\/|$)/, /^\/logs(\/|$)/, /^\/folders(\/|$)/, /^\/hub\/(reports|blocks)(\/|$)/,
    // Subsonic mutates over GET (`/rest/createPlaylist.view?...`).
    /^\/rest\/(create|delete|update)\w*/,
];

function isLoopback(addr: string | undefined): boolean {
    return !!addr && (addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127."));
}

export function isDemoAdmin(req: Pick<express.Request, "headers"> & { socket?: { remoteAddress?: string } }): boolean {
    return isLoopback(req.socket?.remoteAddress) && req.headers["x-forwarded-for"] === undefined;
}

/** Pure decision, exported for tests: may a non-admin client do `method path`? */
export function demoAllows(method: string, path: string): boolean {
    const m = method.toUpperCase();
    const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
    if (WRITE_METHODS.has(m)) return VIEWER_WRITES.some(([vm, re]) => vm === m && re.test(p));
    return !ADMIN_READS.some((re) => re.test(p));
}

export const demoGuard: express.RequestHandler = (req, res, next) => {
    if (isDemoAdmin(req) || demoAllows(req.method, req.path)) { next(); return; }
    res.status(403).json({ error: "demo_read_only", message: "This public demo server is read-only for clients." });
};
