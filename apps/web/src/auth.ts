import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";
import { userOauthTokens } from "@/db/schema-projects-normalized";
import { encryptToken } from "@/lib/token-crypto";
import { eq, and } from "drizzle-orm";

// Optional: comma-separated list of email addresses allowed to sign in.
// Empty / unset = open registration. Useful for self-hosted single-tenant
// deployments to refuse unknown sign-ups at the auth boundary instead of
// relying on every downstream route to re-check.
const ALLOWED_EMAILS = (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth({
    adapter: DrizzleAdapter(db),
    trustHost: true,
    providers: [
        Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
        }),
        GitHub({
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET,
            // `repo` is needed to create private mmo-projects repo.
            authorization: { params: { scope: "read:user repo" } },
        }),
    ],
    pages: {
        signIn: "/login",
    },
    callbacks: {
        async signIn({ user, account }) {
            // Sign-in is restricted to Google. GitHub is allowed only as a
            // "link" flow for users already signed in via Google — handled
            // by Auth.js: `account.provider === "github"` arrives with the
            // existing user attached, so we accept it as a link.
            if (account?.provider === "github") return true;
            if (account?.provider !== "google") return false;

            // Google federation gives us `email_verified`; refuse unverified
            // addresses to block trivial impersonation via a Google Workspace
            // alias trick.
            const emailVerified = (account as unknown as { email_verified?: boolean }).email_verified
                ?? (user as unknown as { emailVerified?: unknown }).emailVerified;
            if (emailVerified === false) return false;

            // Optional allowlist for single-tenant deployments.
            if (ALLOWED_EMAILS.length > 0) {
                const email = user.email?.toLowerCase();
                if (!email || !ALLOWED_EMAILS.includes(email)) return false;
            }
            return true;
        },
        // Redirect callback: keep users on this origin. Auth.js's default
        // already strips cross-origin URLs, but we tighten by also
        // rejecting protocol-relative (`//evil.com/...`) and any URL whose
        // origin doesn't match `baseUrl` after parsing.
        redirect({ url, baseUrl }) {
            try {
                if (url.startsWith("/") && !url.startsWith("//")) {
                    return `${baseUrl}${url}`;
                }
                const parsed = new URL(url);
                if (parsed.origin === baseUrl) return url;
            } catch { /* fall through */ }
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
});
