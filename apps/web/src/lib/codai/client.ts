import "server-only";

/**
 * codai model resolution for a signed-in user.
 *
 * Key precedence:
 *   1. per-user minted key (ai_provider_connections provider="codai") —
 *      minted on first use when CODAI_APP_TOKEN is set;
 *   2. server key CODAI_API_KEY (everyone shares one budget);
 *   3. nothing → mock model (dev / tests), or `undefined` from
 *      `resolveCodaiKey` so callers can fall back to another provider.
 *
 * Every model carries `x-codai-session-id = userId` for sticky prompt caching.
 */

import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { LanguageModel } from "ai";
import {
    CODAI_TIER_MODEL,
    codaiEmbeddings,
    codaiLanguageModel,
    isCodaiConfigured,
    type CodaiTier,
} from "@mmo/ai/providers/codai";
import { canMintUserKeys, getOrMintUserKey, getStoredUserKey } from "./mgmt";

export type { CodaiTier };

export interface ResolvedCodaiKey {
    key: string;
    source: "user" | "server";
    /** Present for per-user keys (the mgmt key id). */
    keyId?: string;
}

/** True when codai can serve requests (server key or per-user minting). */
export function isCodaiAvailable(): boolean {
    return isCodaiConfigured() || canMintUserKeys();
}

/**
 * Resolve the codai key for a user. Never throws on mint failure when a
 * server key exists — logs and falls back to it.
 */
export async function resolveCodaiKey(userId: string): Promise<ResolvedCodaiKey | undefined> {
    if (canMintUserKeys()) {
        try {
            const stored = await getStoredUserKey(userId);
            if (stored) return { key: stored.key, source: "user", keyId: stored.id };
            const email = await userEmail(userId);
            if (email) {
                const minted = await getOrMintUserKey({ userId, email });
                return { key: minted.key, source: "user", keyId: minted.id };
            }
        } catch (err) {
            if (!isCodaiConfigured()) throw err;
            console.warn("[codai] per-user key unavailable, using server key:", err instanceof Error ? err.message : err);
        }
    }
    const serverKey = process.env.CODAI_API_KEY;
    if (serverKey) return { key: serverKey, source: "server" };
    return undefined;
}

/** Language model for a tier, keyed per user with sticky session header. */
export async function getCodaiModel(userId: string, tier: CodaiTier = "default"): Promise<LanguageModel> {
    const resolved = await resolveCodaiKey(userId);
    return codaiLanguageModel(CODAI_TIER_MODEL[tier], { apiKey: resolved?.key, sessionId: userId }) as LanguageModel;
}

/** Embedding model (`codai-embed`). Throws when no key is available. */
export async function getCodaiEmbeddings(userId: string) {
    const resolved = await resolveCodaiKey(userId);
    if (!resolved) throw new Error("codai: no API key available for embeddings");
    return codaiEmbeddings("codai-embed", { apiKey: resolved.key, sessionId: userId });
}

async function userEmail(userId: string): Promise<string | undefined> {
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
    return row?.email ?? undefined;
}
