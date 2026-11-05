import { NextRequest, NextResponse } from "next/server";
import { requireRate } from "@/lib/api-guard";
import { findDeviceByToken } from "@/lib/device-token";
import { log } from "@/lib/logger";
import { bearerToken } from "@/lib/native-auth/session";
import { fanOut, relayBodySchema, toMessage } from "@/lib/push-native/relay";
import { createApnsSender, createFcmSender } from "@/lib/push-native/senders";
import {
    PushUnavailableError, claimRelayEvent, deleteTokensById, releaseRelayEvent, tokensForUser, touchTokens,
} from "@/lib/push-native/store";

/**
 * POST /api/push/relay — MMO Server → phones (server/README.md § Push relay).
 * Auth: `Authorization: Bearer <deviceToken>` (same as /api/media/sync). Dedupes on `eventId`.
 * Responses: 200 {sent,…} · 202 {duplicate:true} · 400 invalid_request · 401 unauthorized ·
 * 403 server_mismatch · 503 push_unavailable (migration 0031 pending) · 502 when every send
 * failed transiently (companion retries 0/1/4 s).
 */

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export async function POST(req: NextRequest) {
    const limited = requireRate(req, { bucket: "push-relay", windowMs: 60_000, max: 120 });
    if (limited) return limited;

    const token = bearerToken(req);
    const device = token ? await findDeviceByToken(token) : null;
    if (!device) return json({ error: "unauthorized" }, 401);

    let raw: unknown;
    try { raw = await req.json(); } catch { raw = null; }
    const parsed = relayBodySchema.safeParse(raw);
    if (!parsed.success) return json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 5).map((i) => i.path.join(".")) }, 400);
    const body = parsed.data;
    // A companion may only speak for itself.
    if (body.serverId !== device.id) return json({ error: "server_mismatch" }, 403);

    try {
        if (!(await claimRelayEvent(body.eventId, device.id, body.event))) return json({ duplicate: true }, 202);
        const tokens = await tokensForUser(device.userId, body.profileId);
        if (tokens.length === 0) return json({ sent: 0, tokens: 0 });
        const result = await fanOut(tokens, toMessage(body), { android: createFcmSender(), ios: createApnsSender() });
        await deleteTokensById(result.dead);
        await touchTokens(result.delivered);
        log.info("[push] relay", { event: body.event, deviceId: device.id, tokens: tokens.length, sent: result.sent, dead: result.dead.length, retry: result.retry, failed: result.failed, skipped: result.skipped });
        if (result.sent === 0 && result.retry > 0) {
            await releaseRelayEvent(body.eventId);
            return json({ error: "upstream_unavailable" }, 502);
        }
        return json({ sent: result.sent, tokens: tokens.length, removed: result.dead.length, failed: result.failed, skipped: result.skipped });
    } catch (e) {
        if (e instanceof PushUnavailableError) return json({ error: "push_unavailable" }, 503);
        log.error("[push] relay failed", e, { deviceId: device.id });
        return json({ error: "internal_error" }, 500);
    }
}
