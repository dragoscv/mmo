import { NextRequest, NextResponse } from "next/server";
import { requireRate } from "@/lib/api-guard";
import { log } from "@/lib/logger";
import { resolveUserId } from "@/lib/native-auth/session";
import { registerBodySchema, unregisterBodySchema } from "@/lib/push-native/relay";
import { PushUnavailableError, deletePushToken, upsertPushToken } from "@/lib/push-native/store";

/**
 * POST /api/push/register — a phone registers its FCM / APNs token.
 * DELETE /api/push/register {token} — sign-out / notifications turned off.
 * Auth: web session cookie OR `Authorization: Bearer <sessionToken>` (native session from
 * /api/device/token or /api/auth/native/*). 503 push_unavailable while migration 0031 is pending.
 */

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" } as const;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

async function readJson(req: NextRequest): Promise<unknown> {
    try { return await req.json(); } catch { return null; }
}

export async function POST(req: NextRequest) {
    const limited = requireRate(req, { bucket: "push-register", windowMs: 60_000, max: 30 });
    if (limited) return limited;
    const userId = await resolveUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const parsed = registerBodySchema.safeParse(await readJson(req));
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    const b = parsed.data;
    try {
        await upsertPushToken({
            userId,
            platform: b.platform,
            token: b.token,
            environment: b.platform === "ios" ? (b.environment ?? "production") : "production",
            deviceName: b.deviceName ?? null,
            profileId: b.profileId ?? null,
            liveActivityToken: b.liveActivityToken ?? null,
        });
        return json({ ok: true });
    } catch (e) {
        if (e instanceof PushUnavailableError) return json({ error: "push_unavailable" }, 503);
        log.error("[push] register failed", e, { userId });
        return json({ error: "internal_error" }, 500);
    }
}

export async function DELETE(req: NextRequest) {
    const limited = requireRate(req, { bucket: "push-register", windowMs: 60_000, max: 30 });
    if (limited) return limited;
    const userId = await resolveUserId(req);
    if (!userId) return json({ error: "unauthorized" }, 401);
    const parsed = unregisterBodySchema.safeParse(await readJson(req));
    if (!parsed.success) return json({ error: "invalid_request" }, 400);
    try {
        const removed = await deletePushToken(userId, parsed.data.token);
        return json({ ok: true, removed });
    } catch (e) {
        if (e instanceof PushUnavailableError) return json({ error: "push_unavailable" }, 503);
        log.error("[push] unregister failed", e, { userId });
        return json({ error: "internal_error" }, 500);
    }
}
