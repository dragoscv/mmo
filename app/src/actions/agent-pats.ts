"use server";

/**
 * Personal Access Tokens for the MCP / REST façade.
 *
 * JWTs are HS256-signed with rotating secrets from env
 * `MMO_PAT_SIGNING_KEYS` — JSON array of {kid, secret} (current key is
 * the first entry; older kids remain valid for verification).
 *
 * The JWT itself is shown to the user ONCE on creation. We only store
 * the `jti`, label, scopes, key version, and timestamps.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { agentPats } from "@/db/schema-ai";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { SignJWT, jwtVerify } from "jose";
import { PAT_SCOPES, type PatScope } from "@/lib/agent-pat-scopes";

interface SigningKey { kid: string; secret: string }

function loadKeys(): SigningKey[] {
    const raw = process.env.MMO_PAT_SIGNING_KEYS;
    if (!raw) {
        // Dev fallback — never use in prod. App still boots without env var.
        return [{ kid: "dev-1", secret: "dev-only-pat-secret-replace-me" }];
    }
    try {
        const parsed = JSON.parse(raw) as SigningKey[];
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("empty");
        return parsed;
    } catch {
        throw new Error("MMO_PAT_SIGNING_KEYS must be a JSON array of {kid, secret}");
    }
}

function currentKey(): SigningKey & { version: number } {
    const keys = loadKeys();
    return { ...keys[0]!, version: 1 };
}

async function uid(): Promise<string> {
    const s = await auth();
    if (!s?.user?.id) throw new Error("Not signed in");
    return s.user.id;
}

export interface PatRowDto {
    id: string;
    label: string;
    scopes: PatScope[];
    keyVersion: number;
    createdAt: Date | null;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
}

export async function listPats(): Promise<PatRowDto[]> {
    const userId = await uid();
    const rows = await db
        .select()
        .from(agentPats)
        .where(eq(agentPats.userId, userId));
    return rows.map((r) => ({
        id: r.id,
        label: r.label,
        scopes: (r.scopes ?? []) as PatScope[],
        keyVersion: r.keyVersion,
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
    }));
}

export async function createPat(input: {
    label: string;
    scopes: PatScope[];
    expiresInDays?: number;
}): Promise<{ id: string; token: string }> {
    const userId = await uid();
    const label = input.label.trim().slice(0, 60);
    if (!label) throw new Error("Label required");
    const scopes = input.scopes.filter((s) => (PAT_SCOPES as readonly string[]).includes(s));
    if (scopes.length === 0) throw new Error("At least one scope required");
    const key = currentKey();
    const jti = crypto.randomUUID();
    const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null;

    const [row] = await db
        .insert(agentPats)
        .values({
            userId,
            jti,
            label,
            scopes,
            keyVersion: key.version,
            expiresAt,
        })
        .returning({ id: agentPats.id });

    const secret = new TextEncoder().encode(key.secret);
    const builder = new SignJWT({ sub: userId, scopes })
        .setProtectedHeader({ alg: "HS256", kid: key.kid })
        .setIssuer("mmo")
        .setAudience("mmo-mcp")
        .setIssuedAt()
        .setJti(jti);
    if (expiresAt) builder.setExpirationTime(Math.floor(expiresAt.getTime() / 1000));
    const token = await builder.sign(secret);

    revalidatePath("/settings/copilot");
    return { id: row!.id, token };
}

export async function revokePat(patId: string): Promise<{ ok: true }> {
    const userId = await uid();
    await db
        .update(agentPats)
        .set({ revokedAt: new Date() })
        .where(and(eq(agentPats.id, patId), eq(agentPats.userId, userId)));
    revalidatePath("/settings/copilot");
    return { ok: true };
}

/** Verification helper used by the MCP/REST façade (P11). */
export async function verifyPat(token: string): Promise<{ userId: string; scopes: PatScope[]; jti: string } | null> {
    const keys = loadKeys();
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"] | null = null;
    let kidUsed: string | null = null;
    for (const k of keys) {
        try {
            const v = await jwtVerify(token, new TextEncoder().encode(k.secret), {
                issuer: "mmo",
                audience: "mmo-mcp",
            });
            payload = v.payload;
            kidUsed = k.kid;
            break;
        } catch {
            /* try next key */
        }
    }
    if (!payload || !kidUsed || !payload.jti) return null;

    const [row] = await db
        .select()
        .from(agentPats)
        .where(and(eq(agentPats.jti, payload.jti), isNull(agentPats.revokedAt)))
        .limit(1);
    if (!row) return null;

    // Best-effort last-used timestamp.
    db.update(agentPats)
        .set({ lastUsedAt: new Date() })
        .where(eq(agentPats.id, row.id))
        .catch(() => {});

    return { userId: row.userId, scopes: (row.scopes ?? []) as PatScope[], jti: payload.jti };
}
