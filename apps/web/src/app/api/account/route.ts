import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRate } from "@/lib/api-guard";
import { DELETE_CONFIRMATION, deleteUserAccount } from "@/lib/account/delete-account";
import { jsonNoStore } from "@/lib/native-auth/exchange";
import { resolveUserId } from "@/lib/native-auth/session";

/**
 * DELETE /api/account — in-app account deletion for the native apps (App Store 5.1.1(v),
 * Google Play). Auth: `Authorization: Bearer <sessionToken>` or the web session cookie.
 * Body: {confirmation: "DELETE"}. → 200 {ok, apple:{revoked,failed}} · 400 confirmation_required ·
 * 401 unauthorized · 500 delete_failed. Web uses the `deleteAccount` server action instead.
 */

export const dynamic = "force-dynamic";

const BodySchema = z.object({ confirmation: z.string().max(32) });

export async function DELETE(req: NextRequest) {
    const limited = requireRate(req, { bucket: "account-delete", windowMs: 60_000, max: 5 });
    if (limited) return limited;
    const userId = await resolveUserId(req);
    if (!userId) return jsonNoStore({ error: "unauthorized" }, 401);
    let raw: unknown;
    try { raw = await req.json(); } catch { raw = null; }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success || parsed.data.confirmation.trim() !== DELETE_CONFIRMATION) {
        return jsonNoStore({ error: "confirmation_required", expected: DELETE_CONFIRMATION }, 400);
    }
    const r = await deleteUserAccount(userId);
    if (!r.ok) return jsonNoStore({ error: r.error ?? "delete_failed" }, r.error === "not_found" ? 404 : 500);
    return jsonNoStore({ ok: true, apple: { revoked: r.apple.revoked, failed: r.apple.failed }, stripe: r.stripe });
}
