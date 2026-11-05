import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts, subscriptions, users, verificationTokens } from "@/db/schema";
import { mcpAuditLog } from "@/db/schema-ai";
import { loraAssets, trainingDatasets } from "@/db/schema-training";
import { revokeAppleToken } from "@/lib/apple/server";
import { log } from "@/lib/logger";

/**
 * Full account deletion (App Store 5.1.1(v), Google Play account-deletion policy, GDPR art. 17).
 *
 * What goes, and how:
 * - Remote credentials first (best-effort, never blocks the local delete):
 *   Sign in with Apple refresh tokens → POST appleid.apple.com/auth/revoke; Stripe customer
 *   → deleted (cancels any subscription).
 * - Rows with NO cascade from `user`: `mcp_audit_log` (plain user_id column),
 *   `verificationToken` (keyed by email), user-scoped `training_datasets` / `lora_assets`
 *   (FK is ON DELETE SET NULL so shared rows survive — the user's private ones must not).
 * - Then `DELETE FROM "user"`: every other per-user table cascades from it — accounts,
 *   sessions, devices (→ device tokens, commands, folders, media_sync_state, push relay
 *   ledger), device_auth_codes, profiles + preferences, watch profiles/history/ratings,
 *   tracks/playlists/tags/cuepoints/track_plays, recordings, subscriptions,
 *   push_subscriptions, push_tokens, ai_provider_connections (codai keys), agent sessions,
 *   PATs, generated assets, projects, oauth tokens, training jobs/feedback.
 */

export interface DeleteAccountDeps {
    appleRefreshTokens(userId: string): Promise<string[]>;
    revokeApple(refreshToken: string): Promise<"revoked" | "unconfigured" | "failed">;
    stripeCustomerId(userId: string): Promise<string | null>;
    deleteStripeCustomer(customerId: string): Promise<void>;
    deleteOrphanRows(userId: string): Promise<void>;
    deleteUserRow(userId: string): Promise<number>;
}

export interface DeleteAccountResult {
    ok: boolean;
    error?: "not_found" | "delete_failed";
    apple: { tokens: number; revoked: number; failed: number; unconfigured: boolean };
    stripe: "none" | "deleted" | "failed";
}

export async function deleteUserAccount(userId: string, deps: DeleteAccountDeps = defaultDeps): Promise<DeleteAccountResult> {
    const apple = { tokens: 0, revoked: 0, failed: 0, unconfigured: false };
    try {
        const tokens = await deps.appleRefreshTokens(userId);
        apple.tokens = tokens.length;
        for (const t of tokens) {
            const r = await deps.revokeApple(t);
            if (r === "revoked") apple.revoked++;
            else if (r === "unconfigured") apple.unconfigured = true;
            else apple.failed++;
        }
    } catch (e) {
        log.warn("[account] apple revoke lookup failed", { userId }, e);
    }

    let stripe: DeleteAccountResult["stripe"] = "none";
    try {
        const customer = await deps.stripeCustomerId(userId);
        if (customer) {
            await deps.deleteStripeCustomer(customer);
            stripe = "deleted";
        }
    } catch (e) {
        stripe = "failed";
        log.warn("[account] stripe customer delete failed", { userId }, e);
    }

    try {
        await deps.deleteOrphanRows(userId);
        const n = await deps.deleteUserRow(userId);
        if (n === 0) return { ok: false, error: "not_found", apple, stripe };
    } catch (e) {
        log.error("[account] user delete failed", e, { userId });
        return { ok: false, error: "delete_failed", apple, stripe };
    }
    log.info("[account] account deleted", { userId, appleRevoked: apple.revoked, appleFailed: apple.failed, stripe });
    return { ok: true, apple, stripe };
}

const defaultDeps: DeleteAccountDeps = {
    async appleRefreshTokens(userId) {
        const rows = await db.select({ t: accounts.refresh_token }).from(accounts)
            .where(and(eq(accounts.userId, userId), eq(accounts.provider, "apple")));
        return rows.map((r) => r.t).filter((t): t is string => !!t);
    },
    revokeApple: (t) => revokeAppleToken(t),
    async stripeCustomerId(userId) {
        const [s] = await db.select({ c: subscriptions.stripeCustomerId }).from(subscriptions)
            .where(eq(subscriptions.userId, userId)).limit(1);
        return s?.c ?? null;
    },
    async deleteStripeCustomer(customerId) {
        if (!process.env.STRIPE_SECRET_KEY) return;
        const { stripe } = await import("@/lib/stripe");
        await stripe().customers.del(customerId);
    },
    async deleteOrphanRows(userId) {
        const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
        await db.transaction(async (tx) => {
            await tx.delete(mcpAuditLog).where(eq(mcpAuditLog.userId, userId));
            await tx.delete(trainingDatasets).where(and(eq(trainingDatasets.userId, userId), eq(trainingDatasets.scope, "user")));
            await tx.delete(loraAssets).where(and(eq(loraAssets.userId, userId), eq(loraAssets.scope, "user")));
            if (u?.email) await tx.delete(verificationTokens).where(eq(verificationTokens.identifier, u.email));
        });
    },
    async deleteUserRow(userId) {
        const rows = await db.delete(users).where(eq(users.id, userId)).returning({ id: users.id });
        return rows.length;
    },
};

/** Typed confirmation the user must enter (both locales accept the same word). */
export const DELETE_CONFIRMATION = "DELETE";
