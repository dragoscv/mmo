"use server";

/**
 * "Add this server to my account" (D59, WP17-98): a server the browser paired WITHOUT an account (Quick Connect,
 * token in localStorage) becomes a `devices` row of the signed-in user, so it follows them to every device.
 * Zod → session → rate limit → URL guard (same SSRF guard as /api/devices/auto-register) → dedupe by token hash
 * → insert. The token is stored like any companion token (HMAC hash + AES-GCM envelope), never logged.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { devices } from "@/db/schema";
import { encryptDeviceToken, hashDeviceToken } from "@/lib/device-token";
import { rateLimit } from "@/lib/rate-limit";
import { validateDeviceApiUrl } from "@/lib/url-guard";

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, name: "guest-server-link" });

const Input = z.object({
    baseUrl: z.string().min(8).max(2048),
    token: z.string().min(16).max(512),
    name: z.string().max(128).optional(),
});

export type LinkGuestResult = { ok: true; deviceId: string; existed: boolean } | { ok: false; error: "auth" | "invalid" | "rate" | "taken" };

export async function linkGuestServer(raw: unknown): Promise<LinkGuestResult> {
    const parsed = Input.safeParse(raw);
    if (!parsed.success) return { ok: false, error: "invalid" };
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return { ok: false, error: "auth" };
    if (limiter.check(userId)) return { ok: false, error: "rate" };

    const apiUrl = validateDeviceApiUrl(parsed.data.baseUrl);
    if (!apiUrl) return { ok: false, error: "invalid" };
    const url = new URL(apiUrl);
    // The hosted web reaches devices only over public https; LAN http stays browser/desktop-only (WP17-97).
    if (url.protocol !== "https:" && process.env.MMO_ALLOW_PRIVATE_DEVICE_URLS !== "1") return { ok: false, error: "invalid" };
    const base = `${url.protocol}//${url.host}`;

    const tokenHash = hashDeviceToken(parsed.data.token);
    const [existing] = await db.select({ id: devices.id, userId: devices.userId }).from(devices).where(eq(devices.tokenHash, tokenHash)).limit(1);
    if (existing) {
        // Same server token already linked: fine for the same user, never re-assigned to another account.
        if (existing.userId !== userId) return { ok: false, error: "taken" };
        await db.update(devices).set({ apiUrl: base }).where(and(eq(devices.id, existing.id), eq(devices.userId, userId)));
        return { ok: true, deviceId: existing.id, existed: true };
    }

    const deviceId = crypto.randomUUID();
    await db.insert(devices).values({
        id: deviceId,
        userId,
        name: (parsed.data.name || url.host).slice(0, 128),
        apiUrl: base,
        tokenHash,
        tokenEncrypted: encryptDeviceToken(parsed.data.token),
        status: "online",
        lastSeenAt: new Date(),
    });
    return { ok: true, deviceId, existed: false };
}
