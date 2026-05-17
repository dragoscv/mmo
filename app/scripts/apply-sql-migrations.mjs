import postgres from "postgres";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const envFile = process.argv[2] ?? ".env.production.local";
if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (!m) continue;
        const k = m[1].trim();
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
    }
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, ssl: "require" });

const dir = "./drizzle";
const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

const tracker = `_manual_migrations`;

try {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${tracker} (
        tag TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    for (const file of files) {
        const tag = file.replace(/\.sql$/, "");
        const [{ exists } = { exists: false }] = await sql`SELECT EXISTS(SELECT 1 FROM ${sql(tracker)} WHERE tag = ${tag}) AS exists`;
        if (exists) {
            console.log(`SKIP ${tag} (already applied)`);
            continue;
        }
        const body = readFileSync(join(dir, file), "utf8");
        // Drizzle splits statements by --> statement-breakpoint
        const statements = body
            .split(/-->\s*statement-breakpoint/i)
            .map((s) => s.trim())
            .filter(Boolean);
        console.log(`APPLY ${tag} (${statements.length} statement(s))`);
        try {
            await sql.begin(async (tx) => {
                for (const stmt of statements) {
                    await tx.unsafe(stmt);
                }
                await tx`INSERT INTO ${tx(tracker)} (tag) VALUES (${tag})`;
            });
            console.log(`  OK`);
        } catch (e) {
            console.error(`  FAIL: ${e.message}`);
            throw e;
        }
    }
    console.log("Done.");
} catch (e) {
    console.error(e);
    process.exitCode = 1;
} finally {
    await sql.end();
}
