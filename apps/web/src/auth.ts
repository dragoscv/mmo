import NextAuth from "next-auth";
import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import Apple from "next-auth/providers/apple";
import type { Provider } from "next-auth/providers";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { userOauthTokens } from "@/db/schema-projects-normalized";
import { encryptToken } from "@/lib/token-crypto";
import { makeAppleClientSecret } from "@/lib/apple/client-secret";
import { appleKeyConfig } from "@/lib/apple/server";
import { authCookiesFor, isAllowedRedirect } from "@/lib/host/auth-cookies";
import { hostRoutingEnabled } from "@/lib/host/products";
import { eq, and } from "drizzle-orm";

// Optional: comma-separated list of email addresses allowed to sign in.
// Empty / unset = open registration. Useful for self-hosted single-tenant
// deployments to refuse unknown sign-ups at the auth boundary instead of
// relying on every downstream route to re-check.
const ALLOWED_EMAILS = (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Sign in with Apple (WP16-51) — env-gated: enabled only when AUTH_APPLE_ID (Services ID,
 * e.g. `ro.mixai.web`) and either AUTH_APPLE_SECRET (pre-built client-secret JWT from
 * scripts/apple-client-secret.mjs) or the raw key (APPLE_KEY_ID + APPLE_PRIVATE_KEY) are set.
 * With the raw key the 6-month JWT is minted at boot, so it never expires on a running fleet.
 */
function appleClientSecret(): string | null {
    if (process.env.AUTH_APPLE_SECRET?.trim()) return process.env.AUTH_APPLE_SECRET.trim();
    const cfg = appleKeyConfig();
    const clientId = process.env.AUTH_APPLE_ID?.trim();
    if (!cfg || !clientId) return null;
    try {
        return makeAppleClientSecret({ ...cfg, clientId });
    } catch {
        return null;
    }
}

export const appleWebEnabled = Boolean(process.env.AUTH_APPLE_ID?.trim() && appleClientSecret());

const providers: Provider[] = [
    Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        // Google asserts `email_verified` for the address and owns the mailbox for gmail /
        // Workspace accounts, so linking a Google sign-in to an existing user with the same
        // VERIFIED email is safe (the signIn callback below refuses unverified emails).
        allowDangerousEmailAccountLinking: true,
    }),
    GitHub({
        clientId: process.env.AUTH_GITHUB_ID,
        clientSecret: process.env.AUTH_GITHUB_SECRET,
        // `repo` is needed to create private mmo-projects repo.
        authorization: { params: { scope: "read:user repo" } },
        // NO email linking for GitHub: its primary email is user-editable.
    }),
];
if (appleWebEnabled) {
    providers.push(Apple({
        clientId: process.env.AUTH_APPLE_ID,
        clientSecret: appleClientSecret() ?? undefined,
        // Apple only releases addresses it verified (real or private-relay; relay addresses
        // are unique per app and can't collide with someone else's mailbox). Same reasoning
        // as Google: an iPhone user who first signed in with Google on the web lands on the
        // same account instead of a duplicate. Unverified emails are refused in signIn.
        allowDangerousEmailAccountLinking: true,
    }));
}

/**
 * Host of the current request. Route handlers and `proxy.ts` pass the request; RSC / server actions call
 * `auth()` without one, so read the forwarded host from `headers()` (Cloud Run passes the custom domain).
 */
async function requestHost(req: { headers: Headers } | undefined): Promise<string | null> {
    let h: Headers | undefined = req?.headers;
    if (!h) {
        try {
            const { headers } = await import("next/headers");
            h = await headers();
        } catch {
            return null; // outside a request scope (scripts, tests)
        }
    }
    return h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
}

function configFor(host: string | null): NextAuthConfig {
    const sameOrigin = (url: string, base: string): boolean => {
        try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
    };
    return {
    adapter: DrizzleAdapter(db),
    trustHost: true,
    providers,
    pages: {
        signIn: "/login",
    },
    // WP17-10: one sign-in across *.mixai.ro (session cookie on `.mixai.ro`); other hosts keep the defaults.
    cookies: hostRoutingEnabled() ? authCookiesFor(host, true) : undefined,
    callbacks: {
        async signIn({ user, account, profile }) {
            // Sign-in is restricted to Google and Apple. GitHub is allowed only as a
            // "link" flow for users already signed in via Google — handled
            // by Auth.js: `account.provider === "github"` arrives with the
            // existing user attached, so we accept it as a link.
            if (account?.provider === "github") return true;
            if (account?.provider !== "google" && account?.provider !== "apple") return false;

            // Google and Apple give us `email_verified` (Apple as boolean or "true");
            // refuse unverified addresses — they would make email linking unsafe.
            const claim = (profile as { email_verified?: unknown } | undefined)?.email_verified;
            const emailVerified = (claim === undefined ? undefined : claim === true || claim === "true")
                ?? (account as unknown as { email_verified?: boolean }).email_verified
                ?? (user as unknown as { emailVerified?: unknown }).emailVerified;
            if (emailVerified === false) return false;

            // Optional allowlist for single-tenant deployments.
            if (ALLOWED_EMAILS.length > 0) {
                const email = user.email?.toLowerCase();
                if (!email || !ALLOWED_EMAILS.includes(email)) return false;
            }
            return true;
        },
        // Redirect callback: same origin only, plus https://*.mixai.ro when signing in on a product host
        // (tv.mixai.ro → login → back to tv.mixai.ro). Protocol-relative (`//evil.com/...`) is refused.
        redirect({ url, baseUrl }) {
            if (url.startsWith("/") && !url.startsWith("//")) return `${baseUrl}${url}`;
            if (hostRoutingEnabled() ? isAllowedRedirect(url, baseUrl) : sameOrigin(url, baseUrl)) return url;
            return baseUrl;
        },
        session({ session, user }) {
            if (session.user) {
                session.user.id = user.id;
            }
            return session;
        },
    },
    events: {
        /**
         * Persist GitHub access tokens encrypted in user_oauth_tokens.
         * Fires when the user goes through the GitHub OAuth flow while
         * already signed in (link flow).
         */
        async linkAccount({ user, account, profile }) {
            if (account.provider !== "github" || !account.access_token || !user.id) return;
            const enc = await encryptToken(account.access_token);
            const refreshEnc = account.refresh_token ? await encryptToken(account.refresh_token) : null;
            const login = (profile as { login?: string } | undefined)?.login ?? null;
            const expiresAt = account.expires_at ? new Date(account.expires_at * 1000) : null;
            const existing = await db
                .select({ id: userOauthTokens.id })
                .from(userOauthTokens)
                .where(and(eq(userOauthTokens.userId, user.id), eq(userOauthTokens.provider, "github")))
                .limit(1);
            if (existing.length === 0) {
                await db.insert(userOauthTokens).values({
                    userId: user.id,
                    provider: "github",
                    providerUserId: account.providerAccountId,
                    login,
                    accessTokenEnc: enc,
                    refreshTokenEnc: refreshEnc,
                    scope: account.scope ?? null,
                    expiresAt,
                });
            } else {
                await db.update(userOauthTokens).set({
                    accessTokenEnc: enc,
                    refreshTokenEnc: refreshEnc,
                    scope: account.scope ?? null,
                    expiresAt,
                    login,
                    updatedAt: new Date(),
                }).where(eq(userOauthTokens.id, existing[0].id));
            }
        },
    },
    };
}

export const { handlers, auth, signIn, signOut } = NextAuth(async (req) => configFor(await requestHost(req)));
