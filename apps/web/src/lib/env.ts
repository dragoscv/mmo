/**
 * Validated environment variable surface.
 *
 * Centralises every `process.env.X` the server reads so we fail fast at
 * startup with a clear error if a required value is missing or weak,
 * rather than crashing at first request — or worse, silently running
 * with a downgraded security posture (e.g. an empty AUTH_SECRET that
 * lets the device-token crypto throw at request time, or a placeholder
 * Stripe webhook secret that quietly accepts unsigned events).
 *
 * Usage: import `serverEnv` anywhere on the server. Tests preload safe
 * defaults via `vitest.setup.ts` so this never throws during test boot.
 *
 * NOT consumed at edge / proxy boundary (proxy.ts) because middleware
 * runs before instrumentation and we don't want a hard crash there;
 * critical secrets are re-checked at each consumer instead.
 */
import "server-only";
import { z } from "zod";

const isProd = process.env.NODE_ENV === "production";

// Loose-but-sane URL-ish predicate. We don't want full URL parsing here
// because postgres:// is not a registered URL scheme in some validators.
const connStringLike = z.string().min(10);

const baseSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Postgres — required everywhere; tests use a dummy value.
    DATABASE_URL: connStringLike,

    // Auth.js — secret used for JWT/session encryption AND derived as the
    // master key for device-token at-rest crypto. Must be high-entropy.
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 chars (use `openssl rand -base64 32`)"),

    // Google OAuth — only provider configured. Required in production;
    // optional in dev so a contributor can boot the app without an OAuth
    // app set up (Google sign-in just won't work until they add one).
    AUTH_GOOGLE_ID: z.string().min(1).optional(),
    AUTH_GOOGLE_SECRET: z.string().min(1).optional(),

    // Stripe — billing webhook signing secret + API secret. Optional in
    // dev; required when STRIPE_SECRET_KEY is present (i.e. billing is
    // wired up at all). The cross-field check lives below.
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    STRIPE_PRICE_PRO_MONTHLY: z.string().optional(),
    STRIPE_PRICE_PRO_YEARLY: z.string().optional(),

    // BYO-AI-keys at-rest crypto. Required only when a user actually
    // tries to store an AI key; we don't enforce here because read-only
    // deployments without that feature wired up shouldn't be blocked.
    // Validated at use site in `crypto-secret.ts`.
    MMO_SECRET_KEY: z.string().optional(),

    // Companion release lookup (public, low-risk).
    COMPANION_REPO_OWNER: z.string().optional(),
    COMPANION_REPO_NAME: z.string().optional(),
    GITHUB_TOKEN: z.string().optional(),

    // Self-hosted LAN escape hatch (consumed by url-guard).
    MMO_ALLOW_PRIVATE_DEVICE_URLS: z.string().optional(),

    // Sentry error tracking — fully optional. The lazy shim in
    // `lib/sentry.ts` short-circuits when SENTRY_DSN is absent, so
    // self-hosted installs without these set pay zero runtime cost.
    SENTRY_DSN: z.string().url().optional().or(z.literal("")),
    SENTRY_ENVIRONMENT: z.string().optional(),
    SENTRY_RELEASE: z.string().optional(),
    SENTRY_SEND_PII: z.string().optional(),
});

const productionRefinements = (env: z.infer<typeof baseSchema>): string[] => {
    const errors: string[] = [];
    if (env.NODE_ENV !== "production") return errors;

    // Google OAuth is the only sign-in path. Missing creds = a deployed
    // app no user can ever log into. Refuse to boot.
    if (!env.AUTH_GOOGLE_ID) errors.push("AUTH_GOOGLE_ID is required in production");
    if (!env.AUTH_GOOGLE_SECRET) errors.push("AUTH_GOOGLE_SECRET is required in production");

    // Stripe: if the SDK key is present, the webhook secret MUST also be
    // set. A live STRIPE_SECRET_KEY without STRIPE_WEBHOOK_SECRET means
    // /api/billing/webhook accepts unsigned forged events (= grant any
    // user any subscription).
    if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
        errors.push("STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set");
    }
    if (env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
        errors.push("STRIPE_SECRET_KEY is a test key in a production build (refusing to boot)");
    }

    // Reject the well-known placeholder dev secrets people copy out of
    // example envs and forget to rotate.
    const weak = new Set([
        "changeme", "secret", "development", "test-secret",
        "test-secret-must-be-at-least-32-bytes-long-aaaaaa",
    ]);
    if (weak.has(env.AUTH_SECRET.toLowerCase())) {
        errors.push("AUTH_SECRET is a placeholder value (refusing to boot)");
    }
    return errors;
};

function loadEnv() {
    const parsed = baseSchema.safeParse(process.env);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("\n");
        // Use console.error directly so this is visible even before our
        // logger is imported (which itself reads env).
        console.error(`\n[env] Invalid environment variables:\n${issues}\n`);
        if (isProd) throw new Error("Invalid environment configuration; refusing to boot.");
    }
    const env = parsed.success ? parsed.data : ({} as z.infer<typeof baseSchema>);

    const refinementErrors = productionRefinements(env);
    if (refinementErrors.length > 0) {
        console.error(`\n[env] Production environment errors:\n${refinementErrors.map((e) => `  - ${e}`).join("\n")}\n`);
        if (isProd) throw new Error("Invalid production environment configuration; refusing to boot.");
    }
    return env;
}

export const serverEnv = loadEnv();
export type ServerEnv = typeof serverEnv;
