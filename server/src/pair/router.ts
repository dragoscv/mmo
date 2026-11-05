/**
 * /pair/* — Quick Connect HTTP surface (see docs/aplicatie/pairing.md).
 *
 *   POST /pair/request   {deviceName, platform}      no auth  → code + secret + qr + approveUrl
 *   GET  /pair/poll?code=&secret=                    no auth  → {status, deviceToken?, userId?}
 *   GET  /pair/info                                  no auth  → server label for discovery UIs
 *   POST /pair/approve   {code}                      auth     → {ok}
 *   GET  /pair/approve?code=&t=<deviceToken>         token in query (phone that scanned the QR)
 *   POST /pair/deny      {code}                      auth     → {ok}
 *   GET  /pair/pending                               auth     → {pending:[...]}
 *
 * Secrets and tokens are never logged.
 */

import express from "express";
import os from "node:os";
import crypto from "node:crypto";
import { store } from "../store";
import { pickLanAddress } from "../lan-announce";
import { log } from "../logger";
import { PairError, PairingService } from "./service";

export interface PairRouterDeps {
    authMiddleware: express.RequestHandler;
    getPort: () => number;
    getVersion: () => string;
    service?: PairingService;
    /** Injectable for tests; defaults to the settings store. */
    getDeviceToken?: () => string | undefined;
    getUserId?: () => string | undefined;
    getWebAppUrl?: () => string | undefined;
    getLanHost?: () => string | null;
}

function tokenMatches(candidate: unknown, stored: string | undefined): boolean {
    if (!stored || typeof candidate !== "string") return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(stored);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendPairError(res: express.Response, err: unknown): void {
    if (err instanceof PairError) {
        res.status(err.status).json({ error: err.message });
        return;
    }
    log("warn", "[pair] unexpected error:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: "Internal error" });
}

export function createPairRouter(deps: PairRouterDeps): express.Router {
    const service = deps.service ?? new PairingService();
    const getDeviceToken = deps.getDeviceToken ?? (() => (store.get("deviceToken") as string | undefined) || undefined);
    const getUserId = deps.getUserId ?? (() => (store.get("userId") as string | undefined) || undefined);
    const getWebAppUrl = deps.getWebAppUrl ?? (() => (store.get("webAppUrl") as string | undefined) || undefined);
    const getLanHost = deps.getLanHost ?? pickLanAddress;

    const router = express.Router();
    router.use(express.json({ limit: "8kb" }));

    router.get("/info", (_req, res) => {
        const port = deps.getPort();
        const host = getLanHost();
        res.json({
            name: os.hostname(),
            version: deps.getVersion(),
            lanUrl: host ? `http://${host}:${port}` : null,
            port,
            pairingSupported: true,
            hasToken: Boolean(getDeviceToken()),
        });
    });

    router.post("/request", (req, res) => {
        if (!getDeviceToken()) {
            // Nothing to hand over yet — the server itself is not set up.
            res.status(503).json({ error: "Server not initialised (no device token)" });
            return;
        }
        try {
            const body = (req.body ?? {}) as { deviceName?: unknown; platform?: unknown };
            const pr = service.request(body);
            const port = deps.getPort();
            const host = getLanHost() ?? "127.0.0.1";
            const webAppUrl = (getWebAppUrl() || "https://mixai.ro").replace(/\/+$/, "");
            const q = `host=${encodeURIComponent(host)}&port=${port}&code=${pr.code}`;
            log("info", `[pair] request code=${pr.code} device="${pr.deviceName}" platform=${pr.platform}`);
            res.status(201).json({
                code: pr.code,
                secret: pr.secret,
                expiresAt: pr.expiresAt,
                qr: `mixai://pair?${q}`,
                approveUrl: `${webAppUrl}/pair?${q}`,
            });
        } catch (err) {
            sendPairError(res, err);
        }
    });

    router.get("/poll", (req, res) => {
        try {
            const result = service.poll(req.query.code, req.query.secret);
            if (result.status !== "approved") {
                res.json(result);
                return;
            }
            const deviceToken = getDeviceToken();
            if (!deviceToken) {
                res.status(503).json({ error: "Server not initialised (no device token)" });
                return;
            }
            log("info", `[pair] token handed over for code=${req.query.code as string}`);
            res.json({ status: "approved", deviceToken, userId: getUserId() ?? null });
        } catch (err) {
            sendPairError(res, err);
        }
    });

    const approveHandler: express.RequestHandler = (req, res) => {
        const code = req.method === "GET"
            ? req.query.code
            : (req.body as { code?: unknown } | undefined)?.code;
        if (!service.approve(code)) {
            res.status(404).json({ error: "Unknown or expired code" });
            return;
        }
        log("info", `[pair] approved code=${String(code)}`);
        res.json({ ok: true, code });
    };

    router.post("/approve", deps.authMiddleware, approveHandler);

    // Query-token variant: a phone that scanned the QR lands on the web
    // app, which redirects here with its own device token in `t`.
    router.get("/approve", (req, res, next) => {
        if (!tokenMatches(req.query.t, getDeviceToken())) {
            res.status(401).json({ error: "Unauthorized" });
            return;
        }
        next();
    }, approveHandler);

    router.post("/deny", deps.authMiddleware, (req, res) => {
        const code = (req.body as { code?: unknown } | undefined)?.code;
        res.json({ ok: service.deny(code) });
    });

    router.get("/pending", deps.authMiddleware, (_req, res) => {
        res.json({ pending: service.listPending() });
    });

    return router;
}
