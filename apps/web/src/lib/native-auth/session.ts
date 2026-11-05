import { randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts, sessions, users } from "@/db/schema";
import type { VerifiedIdentity } from "./verify";

/**
 * Session minting + bearer resolution shared by the native sign-in routes.
 *
 * A native session is a plain Auth.js `session` row (30 days), the same credential
 * `/api/device/token` and `/api/auth/desktop-bootstrap` mint. Apps send it back as
 * `Authorization: Bearer <sessionToken>` (or set it as the `authjs.session-token`
 * cookie in a web view).
 */

export const NATIVE_SESSION_DAYS = 30;

export interface MintedSession {
    sessionToken: string;
    expires: Date;
    user: { id: string; name: string | null; email: string | null; image: string | null };
}

export async function mintSession(userId: string, now = Date.now()): Promise<MintedSession> {
    const sessionToken = randomUUID();
    const expires = new Date(now + NATIVE_SESSION_DAYS * 24 * 60 * 60 * 1000);
    await db.insert(sessions).values({ sessionToken, userId, expires });
    const [u] = await db.select({ id: users.id, name: users.name, email: users.email, image: users.image })
        .from(users).where(eq(users.id, userId)).limit(1);
    return { sessionToken, expires, user: u ?? { id: userId, name: null, email: null, image: null } };
}

/**
 * Find the user for a verified provider identity, linking or creating as needed.
 *
 * Linking by email happens ONLY when the provider asserts the address is verified —
 * Apple and Google both own the mailbox verification for their accounts (Apple
 * private-relay addresses are unique per app, so they never collide with a real one).
 * Any other provider (GitHub) never links by email. Returns `link_conflict` when an
 * unverified email matches an existing user, so the caller can tell the app to sign in
 * with the original provider first.
 */
export async function findOrCreateUserForIdentity(
    id: VerifiedIdentity,
    extra: { name?: string | null; refreshToken?: string | null } = {},
): Promise<{ userId: string; created: boolean } | { error: "link_conflict" | "email_required" }> {
    const [existing] = await db.select({ userId: accounts.userId }).from(accounts)
        .where(and(eq(accounts.provider, id.provider), eq(accounts.providerAccountId, id.sub))).limit(1);
    if (existing) {
        if (extra.refreshToken) {
            await db.update(accounts).set({ refresh_token: extra.refreshToken })
                .where(and(eq(accounts.provider, id.provider), eq(accounts.providerAccountId, id.sub)));
        }
        return { userId: existing.userId, created: false };
    }

    let userId: string | null = null;
    let created = false;
    if (id.email) {
        const [byEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, id.email)).limit(1);
        if (byEmail) {
            if (!id.emailVerified) return { error: "link_conflict" };
            userId = byEmail.id;
        }
    }
    if (!userId) {
        if (!id.email) return { error: "email_required" };
        const [u] = await db.insert(users).values({
            email: id.email,
            emailVerified: id.emailVerified ? new Date() : null,
            name: extra.name ?? id.name,
            image: id.picture,
        }).returning({ id: users.id });
        userId = u.id;
        created = true;
    }
    await db.insert(accounts).values({
        userId,
        type: "oidc",
        provider: id.provider,
        providerAccountId: id.sub,
        refresh_token: extra.refreshToken ?? null,
    }).onConflictDoNothing();
    return { userId, created };
}

export function bearerToken(req: Request): string | null {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
    return m?.[1]?.trim() || null;
}

/** Resolve an Auth.js session token sent as a bearer by a native app. */
export async function userIdFromSessionBearer(token: string): Promise<string | null> {
    if (token.length < 16 || token.length > 200) return null;
    const [row] = await db.select({ userId: sessions.userId }).from(sessions)
        .where(and(eq(sessions.sessionToken, token), gt(sessions.expires, new Date()))).limit(1);
    return row?.userId ?? null;
}

/** Cookie session (web) first, then `Authorization: Bearer <sessionToken>` (native). */
export async function resolveUserId(req: Request): Promise<string | null> {
    const token = bearerToken(req);
    if (token) return userIdFromSessionBearer(token);
    const session = await auth();
    return session?.user?.id ?? null;
}
