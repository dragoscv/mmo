import { readFileSync } from "node:fs";
import postgres from "postgres";

try {
    const txt = readFileSync(".env.local", "utf8");
    for (const line of txt.split(/\r?\n/)) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) {
            let v = m[2].trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
            process.env[m[1]] = v;
        }
    }
} catch { /* ignore */ }

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });

async function main() {
    const rows = await sql`
        SELECT id, name, status, item_count, gcs_uri, tag_histogram
        FROM training_datasets
        WHERE status = 'ready'
        ORDER BY created_at DESC
    `;
    console.log("Ready datasets:");
    for (const r of rows as unknown as Array<Record<string, unknown>>) {
        const hist = r.tag_histogram as Record<string, number> | null;
        const topTags = hist ? Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(",") : "";
        console.log(`  id=${r.id}`);
        console.log(`    name=${r.name}  items=${r.item_count}  gcs=${r.gcs_uri ?? "-"}`);
        console.log(`    topTags=${topTags}`);
    }
    await sql.end();
}
main();
