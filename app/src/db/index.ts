/**
 * Postgres database client (Drizzle + postgres-js).
 *
 * Source-of-truth for app metadata. Connection string comes from
 * `DATABASE_URL`; in production this points at Cloud SQL via public IP +
 * SSL, in dev it can point at a local docker postgres OR the cloud
 * instance directly.
 *
 * Why `postgres-js` instead of `pg`?
 *  - 30%+ faster cold-starts in serverless (no native bindings)
 *  - Native pipelining + prepared-statement caching
 *  - First-class Drizzle support
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error(
        "DATABASE_URL is not set. Provide a Postgres connection string " +
        "(see infra/terraform/README.md) in app/.env.local or your hosting env.",
    );
}

// Detect serverless to keep the pool tiny — Vercel functions are short-lived
// and many concurrent invocations would otherwise saturate Cloud SQL.
const isServerless = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// `globalThis` cache prevents creating a new pool on every Hot Reload in
// `next dev` (which would exhaust connections fast).
const globalForDb = globalThis as unknown as { __mmoSql?: ReturnType<typeof postgres> };

const sqlClient = globalForDb.__mmoSql ?? postgres(connectionString, {
    max: isServerless ? 1 : 10,
    idle_timeout: isServerless ? 20 : 0,
    connect_timeout: 30,
    // Cloud SQL public IP requires SSL but the cert chain is signed by Google's
    // root which Node trusts; `require` is enough.
    ssl: connectionString.includes("sslmode=require") ? "require" : undefined,
    prepare: false, // safer with PgBouncer / serverless poolers
});

if (process.env.NODE_ENV !== "production") {
    globalForDb.__mmoSql = sqlClient;
}

export const db = drizzle(sqlClient, { schema });
export { sqlClient as sql };
