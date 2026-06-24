/**
 * @mmo/db — shared Drizzle schema (single source of truth).
 *
 * Consumed by:
 *   - apps/web (Next.js)  — via tsconfig path alias + thin re-export shims
 *     at apps/web/src/db/schema*.ts (keeps the existing `@/db/schema`
 *     imports working unchanged).
 *   - apps/gateway (Hono) — imports the control-plane tables directly.
 *
 * Only schema lives here. DB clients stay per-app (different pool sizes,
 * runtimes, and connection strategies).
 */

export * from "./schema";
export * as schema from "./schema";
export { setDb, getDb } from "./runtime-db";
export * from "./sync-apply";
