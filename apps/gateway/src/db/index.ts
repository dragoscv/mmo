/**
 * Postgres client for the gateway (Drizzle + postgres-js).
 *
 * Reuses the SAME `DATABASE_URL` as the web app — the gateway is a second
 * stateless reader/writer of the shared control-plane tables. Cloud Run
 * scales to multiple instances, so the pool is kept small per instance.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error("DATABASE_URL is required for the gateway");
}

const client = postgres(connectionString, {
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    ssl: connectionString.includes("sslmode=require") ? "require" : undefined,
});

export const db = drizzle(client, { schema });
export { client };
export * as schema from "./schema.js";

// Inject this client into the shared data-plane logic (@mmo/db sync-apply)
// so the gateway runs the identical conflict-resolution code as apps/web.
import { setDb } from "@mmo/db";
setDb(db);
