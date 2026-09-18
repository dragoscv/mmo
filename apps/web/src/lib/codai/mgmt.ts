import "server-only";

/**
 * codai management API — mint / list / revoke per-end-user keys.
 *
 * Base: CODAI_MGMT_URL (default https://api.codai.ro). Auth: the MixAI
 * app token (`CODAI_APP_TOKEN`, `codai_app_…`). Every response is an
 * envelope `{ ok: true, data }` | `{ ok: false, error }`.
 *
 * Per-user keys are persisted in `ai_provider_connections` as
 * provider="codai", label="mixai:<userId>", encApiKey = AES-GCM envelope
 * (lib/token-crypto), endpointsJson = { keyId } — no new table/migration.
 * The plaintext key is only ever returned once by the mint call.
 */

import { db } from "@/db";
import { aiProviderConnections } from "@/db/schema-ai";
import { decryptToken, encryptToken } from "@/lib/token-crypto";
import { and, eq } from "drizzle-orm";

export const CODAI_DEFAULT_MGMT_URL = "https://api.codai.ro";

export interface MintedKey {
    id: string;
    /** Plaintext key — returned exactly once by the mgmt API. */
    key: string;
}

export interface CodaiKeyRecord {
    id: string;
    label?: string;
    endUserExternalId?: string;
    revokedAt?: string | null;
    createdAt?: string;
    [k: string]: unknown;
}

export class CodaiMgmtError extends Error {
    constructor(message: string, readonly status?: number, readonly code?: string) {
        super(message);
        this.name = "CodaiMgmtError";
    }
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error?: { code?: string; message?: string } | string };

export function codaiMgmtUrl(): string {
    return (process.env.CODAI_MGMT_URL ?? CODAI_DEFAULT_MGMT_URL).replace(/\/+$/, "");
}

/** True when MixAI can mint per-user keys. */
export function canMintUserKeys(): boolean {
    return !!process.env.CODAI_APP_TOKEN;
}

export function userKeyLabel(userId: string): string {
    return `mixai:${userId}`;
}

function appToken(): string {
    const t = process.env.CODAI_APP_TOKEN;
    if (!t) throw new CodaiMgmtError("CODAI_APP_TOKEN not configured", undefined, "not_configured");
    return t;
}

async function mgmtFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${codaiMgmtUrl()}${path}`, {
        ...init,
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${appToken()}`,
            ...(init.headers ?? {}),
        },
    });
    let body: Envelope<T> | undefined;
    try {
        body = (await res.json()) as Envelope<T>;
    } catch {
        body = undefined;
    }
    if (!res.ok) {
        const msg = body && !body.ok ? describeError(body.error) : `${res.status} ${res.statusText}`;
        throw new CodaiMgmtError(`codai mgmt ${path} failed: ${msg}`, res.status, errorCode(body));
    }
    if (!body || typeof body !== "object" || !("ok" in body)) {
        throw new CodaiMgmtError(`codai mgmt ${path}: malformed envelope`, res.status, "malformed");
    }
    if (!body.ok) {
        throw new CodaiMgmtError(`codai mgmt ${path}: ${describeError(body.error)}`, res.status, errorCode(body));
    }
    return body.data;
}

function describeError(err: unknown): string {
    if (!err) return "unknown error";
    if (typeof err === "string") return err;
    if (typeof err === "object" && err && "message" in err) return String((err as { message?: unknown }).message ?? "error");
    return JSON.stringify(err);
}

function errorCode(body: Envelope<unknown> | undefined): string | undefined {
    if (!body || body.ok) return undefined;
    const e = body.error;
    return typeof e === "object" && e && "code" in e ? e.code : undefined;
}

function budgetEurPerDay(): number {
    const raw = Number(process.env.CODAI_USER_BUDGET_EUR_PER_DAY ?? "1");
    return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** POST /apps/keys → { id, key }. Key plaintext is only available here. */
export async function mintUserKey(opts: { userId: string; email: string; allowedModels?: string[] }): Promise<MintedKey> {
    const data = await mgmtFetch<{ id: string; key: string }>("/apps/keys", {
        method: "POST",
        body: JSON.stringify({
            email: opts.email,
            endUserExternalId: opts.userId,
            label: userKeyLabel(opts.userId),
            budgetEurPerDay: budgetEurPerDay(),
            ...(opts.allowedModels ? { allowedModels: opts.allowedModels } : {}),
        }),
    });
    if (!data?.id || !data?.key) throw new CodaiMgmtError("codai mgmt /apps/keys: missing id/key", undefined, "malformed");
    return { id: data.id, key: data.key };
}

/** DELETE /apps/keys/:id */
export async function revokeUserKey(keyId: string): Promise<void> {
    await mgmtFetch<unknown>(`/apps/keys/${encodeURIComponent(keyId)}`, { method: "DELETE" });
}

/** GET /apps/keys?endUserExternalId= */
export async function listUserKeys(endUserExternalId: string): Promise<CodaiKeyRecord[]> {
    const data = await mgmtFetch<CodaiKeyRecord[] | { keys?: CodaiKeyRecord[] }>(
        `/apps/keys?endUserExternalId=${encodeURIComponent(endUserExternalId)}`,
    );
    if (Array.isArray(data)) return data;
    return data?.keys ?? [];
}

// ─── Persistence (ai_provider_connections, provider="codai") ──────────────

type ConnectionRow = typeof aiProviderConnections.$inferSelect;

async function loadStoredKeyRow(userId: string): Promise<ConnectionRow | undefined> {
    const [row] = await db
        .select()
        .from(aiProviderConnections)
        .where(
            and(
                eq(aiProviderConnections.userId, userId),
                eq(aiProviderConnections.provider, "codai"),
                eq(aiProviderConnections.label, userKeyLabel(userId)),
                eq(aiProviderConnections.status, "active"),
            ),
        )
        .limit(1);
    return row;
}

export interface StoredUserKey extends MintedKey {
    connectionId: string;
}

/** Decrypt the stored per-user key, or undefined when none is minted yet. */
export async function getStoredUserKey(userId: string): Promise<StoredUserKey | undefined> {
    const row = await loadStoredKeyRow(userId);
    if (!row?.encApiKey) return undefined;
    const keyId = (row.endpointsJson as { keyId?: string } | null)?.keyId ?? row.id;
    return { connectionId: row.id, id: keyId, key: await decryptToken(row.encApiKey) };
}

/**
 * Return the user's codai key, minting + persisting one on first use.
 * Requires CODAI_APP_TOKEN; callers should check `canMintUserKeys()` and
 * fall back to the server key (`CODAI_API_KEY`) otherwise.
 */
export async function getOrMintUserKey(opts: { userId: string; email: string }): Promise<StoredUserKey> {
    const existing = await getStoredUserKey(opts.userId);
    if (existing) return existing;

    const minted = await mintUserKey(opts);
    const encApiKey = await encryptToken(minted.key);
    const now = new Date();
    const [row] = await db
        .insert(aiProviderConnections)
        .values({
            userId: opts.userId,
            provider: "codai",
            label: userKeyLabel(opts.userId),
            encApiKey,
            endpointsJson: { keyId: minted.id },
            status: "active",
            lastVerifiedAt: now,
            createdAt: now,
            updatedAt: now,
        })
        .onConflictDoUpdate({
            target: [aiProviderConnections.userId, aiProviderConnections.provider, aiProviderConnections.label],
            set: { encApiKey, endpointsJson: { keyId: minted.id }, status: "active", updatedAt: now },
        })
        .returning();
    return { connectionId: row!.id, id: minted.id, key: minted.key };
}

/** Revoke upstream and mark the local row revoked. No-op when nothing is stored. */
export async function revokeStoredUserKey(userId: string): Promise<boolean> {
    const row = await loadStoredKeyRow(userId);
    if (!row) return false;
    const keyId = (row.endpointsJson as { keyId?: string } | null)?.keyId;
    if (keyId) await revokeUserKey(keyId);
    await db
        .update(aiProviderConnections)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(eq(aiProviderConnections.id, row.id));
    return true;
}
