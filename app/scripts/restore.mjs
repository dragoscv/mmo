/**
 * Restore CLI — re-applies a backup.json into the database. Idempotent on
 * primary key (uses ON CONFLICT DO UPDATE for tables with a single PK,
 * delete-and-insert for composite-key join tables).
 *
 * Usage:
 *   node scripts/restore.mjs --in ./backup.json [--dry-run]
 */

import postgres from "postgres";
import fs from "node:fs/promises";

const ORDER = [
    "user_preferences",
    "user_profiles",
    "profile_preferences",
    "devices",
    "device_folders",
    "tracks",
    "tags",
    "track_tags",
    "playlists",
    "playlist_tracks",
    "cuepoints",
    "recordings",
    "subscriptions",
];

const COMPOSITE_KEY_TABLES = {
    playlist_tracks: ["playlist_id", "track_id"],
    track_tags: ["track_id", "tag_id"],
};

function parseArgs() {
    const args = process.argv.slice(2);
    const out = { file: "./backup.json", dryRun: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--in") out.file = args[++i];
        else if (args[i] === "--dry-run") out.dryRun = true;
    }
    return out;
}

async function main() {
    const { file, dryRun } = parseArgs();
    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL not set");
        process.exit(2);
    }
    const dump = JSON.parse(await fs.readFile(file, "utf8"));
    const sql = postgres(process.env.DATABASE_URL, {
        ssl: process.env.DATABASE_URL.includes("sslmode=require") ? "require" : undefined,
    });

    await sql.begin(async (tx) => {
        for (const table of ORDER) {
            const rows = dump.tables[table];
            if (!rows || rows.length === 0) continue;
            console.error(`  ${table}: ${rows.length} rows`);
            if (dryRun) continue;

            const compositeKeys = COMPOSITE_KEY_TABLES[table];
            if (compositeKeys) {
                // Delete existing rows for the composite keys we're inserting.
                for (const r of rows) {
                    const where = compositeKeys.map((k, i) => `"${k}" = $${i + 1}`).join(" AND ");
                    const vals = compositeKeys.map((k) => r[k]);
                    await tx.unsafe(`DELETE FROM "${table}" WHERE ${where}`, vals);
                }
            }
            for (const row of rows) {
                const cols = Object.keys(row);
                const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
                const vals = cols.map((c) => row[c]);
                const onConflict = compositeKeys
                    ? "" // already cleared above
                    : `ON CONFLICT (${quoteFirstPK(table)}) DO UPDATE SET ${cols
                        .filter((c) => c !== firstPK(table))
                        .map((c) => `"${c}" = EXCLUDED."${c}"`)
                        .join(", ")}`;
                const stmt = `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders}) ${onConflict}`;
                await tx.unsafe(stmt, vals);
            }
        }
    });

    await sql.end();
    console.error(dryRun ? "Dry-run complete." : "Restore complete.");
}

// Tables with non-`id` primary key:
function firstPK(table) {
    if (table === "subscriptions") return "user_id";
    if (table === "user_profiles") return "id";
    return "id";
}
function quoteFirstPK(table) {
    return `"${firstPK(table)}"`;
}

main().catch((e) => { console.error(e); process.exit(1); });
