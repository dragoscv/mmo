"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { userPreferences } from "@/db/schema";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto-secret";
import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { SUPPORTED_PROVIDERS, type AiProvider, type AiKeyInfo } from "@/lib/ai-providers";

/**
 * BYO API keys for AI providers. Stored encrypted at rest in
 * `user_preferences` under the `secret:<provider>` namespace. Never
 * returned in plaintext to the client — the settings UI receives a
 * masked preview only.
 */

const NS = (provider: AiProvider) => `secret:ai:${provider}`;

export async function listAiKeys(): Promise<AiKeyInfo[]> {
    const session = await auth();
    if (!session?.user?.id) return SUPPORTED_PROVIDERS.map((p) => ({ provider: p, isSet: false, masked: "", updatedAt: null }));
    const rows = await db
        .select({ key: userPreferences.key, value: userPreferences.value, updatedAt: userPreferences.updatedAt })
        .from(userPreferences)
        .where(eq(userPreferences.userId, session.user.id));
    const byProvider = new Map<string, { value: string; updatedAt: Date | null }>();
    for (const row of rows) {
        for (const p of SUPPORTED_PROVIDERS) {
            if (row.key === NS(p)) byProvider.set(p, { value: row.value, updatedAt: row.updatedAt });
        }
    }
    return SUPPORTED_PROVIDERS.map((provider) => {
        const stored = byProvider.get(provider);
        if (!stored) return { provider, isSet: false, masked: "", updatedAt: null };
        try {
            const plain = decryptSecret(stored.value);
            return { provider, isSet: true, masked: maskSecret(plain), updatedAt: stored.updatedAt };
        } catch {
            // Either MMO_SECRET_KEY rotated or the row is malformed.
            return { provider, isSet: true, masked: "(unreadable — re-enter)", updatedAt: stored.updatedAt };
        }
    });
}

/** Returns the plaintext key for server-side use. Never expose to client. */
export async function getAiKey(provider: AiProvider): Promise<string | null> {
    const session = await auth();
    if (!session?.user?.id) return null;
    const rows = await db
        .select({ value: userPreferences.value })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, NS(provider))))
        .limit(1);
    if (!rows[0]) return null;
    try { return decryptSecret(rows[0].value); } catch { return null; }
}

export async function setAiKeyAction(
    provider: AiProvider,
    plaintext: string,
): Promise<{ ok: boolean; error?: string }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false, error: "Not signed in" };
    if (!SUPPORTED_PROVIDERS.includes(provider)) return { ok: false, error: "Unknown provider" };
    const trimmed = plaintext.trim();
    if (trimmed.length < 8 || trimmed.length > 500) {
        return { ok: false, error: "Key looks invalid (must be 8–500 chars)" };
    }
    let blob: string;
    try { blob = encryptSecret(trimmed); } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const ns = NS(provider);
    const existing = await db
        .select({ id: userPreferences.id })
        .from(userPreferences)
        .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, ns)))
        .limit(1);
    if (existing[0]) {
        await db.update(userPreferences)
            .set({ value: blob, updatedAt: new Date() })
            .where(eq(userPreferences.id, existing[0].id));
    } else {
        await db.insert(userPreferences).values({
            userId: session.user.id, key: ns, value: blob,
        });
    }
    revalidatePath("/settings");
    return { ok: true };
}

export async function deleteAiKeyAction(
    provider: AiProvider,
): Promise<{ ok: boolean }> {
    const session = await auth();
    if (!session?.user?.id) return { ok: false };
    await db.delete(userPreferences)
        .where(and(eq(userPreferences.userId, session.user.id), eq(userPreferences.key, NS(provider))));
    revalidatePath("/settings");
    return { ok: true };
}
