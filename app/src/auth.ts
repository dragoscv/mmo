import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db } from "@/db";

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
    ],
    pages: {
        signIn: "/login",
    },
    callbacks: {
        async signIn({ user, account }) {
            // Defence in depth: only the configured Google provider may
            // create accounts. If a future provider is wired up by mistake
            // (or via env override) it will be rejected here.
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
});
