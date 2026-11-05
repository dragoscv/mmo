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
import * as schemaCore from "./schema";
import * as schemaAi from "./schema-ai";
import * as schemaTraining from "./schema-training";

const schema = { ...schemaCore, ...schemaAi, ...schemaTraining };

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
// Cloud Run sets K_SERVICE. Instances scale out (max 4) against a db-f1-micro (~25 connections),
// so keep the per-instance pool small and drop idle connections; DB_POOL_MAX overrides.
const isCloudRun = !!process.env.K_SERVICE;
const poolMax = Number(process.env.DB_POOL_MAX) || (isServerless ? 1 : isCloudRun ? 4 : 10);

// `globalThis` cache prevents creating a new pool on every Hot Reload in
// `next dev` (which would exhaust connections fast).
const globalForDb = globalThis as unknown as { __mmoSql?: ReturnType<typeof postgres> };

// Cloud Run: `--add-cloudsql-instances` mounts the Cloud SQL socket under /cloudsql/<connection>.
// When DB_SOCKET_DIR is set, connect through it (credentials/db still come from DATABASE_URL);
// the auth proxy encrypts the hop, so no client SSL on the socket.
const socketDir = process.env.DB_SOCKET_DIR;

const sqlClient = globalForDb.__mmoSql ?? postgres(connectionString, {
    max: poolMax,
    idle_timeout: isServerless || isCloudRun ? 20 : 0,
    connect_timeout: 30,
    // Cloud SQL public IP requires SSL but the cert chain is signed by Google's
    // root which Node trusts; `require` is enough.
    ssl: !socketDir && connectionString.includes("sslmode=require") ? "require" : false,
    ...(socketDir ? { host: socketDir } : {}),
    prepare: false, // safer with PgBouncer / serverless poolers
});

if (process.env.NODE_ENV !== "production") {
    globalForDb.__mmoSql = sqlClient;
}

export const db = drizzle(sqlClient, { schema });
export { sqlClient as sql };

// Inject this client into the shared data-plane logic (sync-apply) so the
// web sync route and the gateway run identical code over their own pools.
import { setDb } from "@mmo/db";
setDb(db);
