/**
 * Control-plane schema slice.
 *
 * The gateway owns only the device control plane, so it declares ONLY the
 * `devices` and `device_commands` tables (plus the `users` FK target it
 * references). These column definitions MUST stay byte-identical to the
 * canonical schema in `apps/web/src/db/schema.ts` — the gateway and the
 * Next.js app share one physical Postgres database. When Phase 2 moves the
 * sync data plane here, we promote this into a shared `packages/db`.
 *
 * No migrations are emitted from here; `apps/web` remains the single owner
 * of `drizzle-kit generate`/migrate against this DB.
 */

import { bigint, index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

// FK target only — the gateway never writes users. Table is "user" (singular).
export const users = pgTable("user", {
    id: text("id").primaryKey(),
});

export const devices = pgTable("devices", {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    os: text("os"),
    hostname: text("hostname"),
    apiUrl: text("api_url").notNull(),
    lanUrl: text("lan_url"),
    lanAnnouncedAt: timestamp("lan_announced_at"),
    tokenHash: text("token_hash").unique(),
    tokenEncrypted: text("token_encrypted"),
    tunnelId: text("tunnel_id"),
    tunnelHostname: text("tunnel_hostname"),
    tunnelTokenEncrypted: text("tunnel_token_encrypted"),
    status: text("status").notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    version: text("version"),
    syncCursor: bigint("sync_cursor", { mode: "number" }).default(0),
    createdAt: timestamp("created_at").defaultNow(),
});

export const deviceCommands = pgTable(
    "device_commands",
    {
        id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
        deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
        kind: text("kind").notNull(),
        payload: jsonb("payload"),
        status: text("status").notNull().default("pending"),
        result: jsonb("result"),
        error: text("error"),
        createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
        dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
        completedAt: timestamp("completed_at", { withTimezone: true }),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [
        index("device_commands_dispatch_idx").on(t.deviceId, t.status, t.createdAt),
        index("device_commands_status_idx").on(t.status, t.expiresAt),
    ],
);
