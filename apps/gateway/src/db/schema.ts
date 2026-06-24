/**
 * Control-plane schema — sourced from the shared `@mmo/db` package (single
 * source of truth shared with apps/web). The gateway uses `devices`,
 * `deviceCommands` and `users`; re-exporting the whole schema keeps
 * Drizzle's relational metadata intact and lets Phase 2 (sync) reach the
 * library tables without further wiring.
 */
export * from "@mmo/db/schema";
