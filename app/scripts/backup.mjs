/**
 * Backup CLI — dumps every row owned by the calling user (or all rows if
 * run with admin DB credentials) to a single JSON file. Pair with
 * `restore.mjs` to round-trip.
 *
 * Usage:
 *   node scripts/backup.mjs --user <user_id> --out ./backup.json
 *   node scripts/backup.mjs --all --out ./backup.json   # full DB dump
 *
 * The output is a stable, sorted, line-delimited-friendly JSON object so
 * git-diff against successive snapshots is meaningful.
 */

import postgres from "postgres";
import fs from "node:fs/promises";

const SYNCED_TABLES = [
    "user_preferences",
    "user_profiles",
    "profile_preferences",
    "devices",
    "device_folders",
    "recordings",
    "tracks",
    "playlists",
    "playlist_tracks",
    "tags",
    "track_tags",
    "cuepoints",
    "subscriptions",
];

function parseArgs() {
    const args = process.argv.slice(2);
    const out = { user: null, all: false, file: "./backup.json" };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--user") out.user = args[++i];
        else if (args[i] === "--all") out.all = true;
        else if (args[i] === "--out") out.file = args[++i];
    }
    return out;
}

async function main() {
    const { user, all, file } = parseArgs();
    if (!user && !all) {
        console.error("Specify --user <id> or --all");
        process.exit(2);
    }
    if (!process.env.DATABASE_URL) {
        console.error("DATABASE_URL not set");
        process.exit(2);
    }

    const sql = postgres(process.env.DATABASE_URL, {
        ssl: process.env.DATABASE_URL.includes("sslmode=require") ? "require" : undefined,
    });

    const dump = { version: 1, exportedAt: new Date().toISOString(), userId: user, tables: {} };
    for (const tbl of SYNCED_TABLES) {
        let rows;
        if (all) {
            rows = await sql.unsafe(`SELECT * FROM "${tbl}" ORDER BY 1`);
        } else {
            // Some tables don't have a user_id directly; join through the obvious parent.
            if (tbl === "playlist_tracks") {
                rows = await sql.unsafe(
                    `SELECT pt.* FROM playlist_tracks pt
                     JOIN playlists p ON pt.playlist_id = p.id
                     WHERE p.user_id = $1 ORDER BY pt.playlist_id, pt.position`,
                    [user],
                );
            } else if (tbl === "track_tags") {
                rows = await sql.unsafe(
                    `SELECT tt.* FROM track_tags tt
                     JOIN tracks t ON tt.track_id = t.id
                     WHERE t.user_id = $1 ORDER BY tt.track_id, tt.tag_id`,
                    [user],
                );
            } else if (tbl === "cuepoints") {
                rows = await sql.unsafe(
                    `SELECT c.* FROM cuepoints c
                     JOIN tracks t ON c.track_id = t.id
                     WHERE t.user_id = $1 ORDER BY c.track_id, c.position_ms`,
                    [user],
                );
            } else if (tbl === "device_folders") {
                rows = await sql.unsafe(
                    `SELECT df.* FROM device_folders df
                     JOIN devices d ON df.device_id = d.id
                     WHERE d.user_id = $1 ORDER BY df.device_id, df.id`,
                    [user],
                );
            } else if (tbl === "profile_preferences") {
                rows = await sql.unsafe(
                    `SELECT pp.* FROM profile_preferences pp
                     JOIN user_profiles up ON pp.profile_id = up.id
                     WHERE up.user_id = $1 ORDER BY pp.profile_id, pp.key`,
                    [user],
                );
            } else {
                rows = await sql.unsafe(
                    `SELECT * FROM "${tbl}" WHERE user_id = $1 ORDER BY 1`,
                    [user],
                );
            }
        }
        dump.tables[tbl] = rows;
        console.error(`  ${tbl}: ${rows.length} rows`);
    }

    await fs.writeFile(file, JSON.stringify(dump, null, 2));
    await sql.end();
    console.error(`Wrote ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
