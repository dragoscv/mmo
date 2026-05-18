#!/usr/bin/env node
/**
 * Custom Postgres migration runner.
 *
 * Replaces `drizzle-kit migrate`, which silently no-ops when the drizzle
 * journal drifts from the SQL files in app/drizzle/. This runner is the
 * source of truth: it reads numeric-prefixed SQL files in lexical order,
 * tracks applied tags in a `_manual_migrations` table, and runs each
 * pending file inside a transaction.
 *
 * Flags:
 *   --env=<path>       Load env vars from this file (default: .env.local).
 *                      Pass --env=- to skip and use the ambient environment.
 *   --prod             Pull production env from Vercel into .env.prod.tmp,
 *                      use it, then delete it. Requires `vercel` CLI logged in.
 *   --status           Print applied / pending migrations and exit.
 *   --mark-applied     Record all pending migrations as applied WITHOUT
 *                      executing them. Use once when adopting this runner on
 *                      a DB that already has the schema.
 *   --dry-run          Print which migrations would run, don't touch the DB.
 *   --yes              Skip the confirmation prompt for --mark-applied.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(APP_ROOT, "..");
const MIGRATIONS_DIR = join(APP_ROOT, "drizzle");
const TRACKER = "_manual_migrations";

const RESET = "\u001b[0m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const argValue = (name) => {
    const a = args.find((x) => x.startsWith(`${name}=`));
    return a ? a.slice(name.length + 1) : null;
};

const STATUS_ONLY = flag("--status");
const MARK_APPLIED = flag("--mark-applied");
const DRY_RUN = flag("--dry-run");
const PROD = flag("--prod");
const YES = flag("--yes");
const ENV_FILE = argValue("--env") ?? (PROD ? null : ".env.local");

function loadEnvFile(p) {
    if (!p || p === "-") return;
    const abs = resolve(APP_ROOT, p);
    if (!existsSync(abs)) {
        console.error(`${RED}Env file not found:${RESET} ${abs}`);
        process.exit(1);
    }
    for (const line of readFileSync(abs, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([^#=]+)=(.*)$/);
        if (!m) continue;
        const k = m[1].trim();
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        if (!process.env[k]) process.env[k] = v;
    }
}

let prodTmpPath = null;

function pullProdEnv() {
    const tmp = join(REPO_ROOT, ".env.prod.tmp");
    console.log(`${DIM}Pulling production env via vercel CLI...${RESET}`);
    const result = spawnSync(
        process.platform === "win32" ? "vercel.cmd" : "vercel",
        ["env", "pull", tmp, "--environment=production", "--yes"],
        { cwd: REPO_ROOT, stdio: "inherit" },
    );
    if (result.status !== 0) {
        console.error(`${RED}Failed to pull vercel env (status ${result.status}).${RESET}`);
        process.exit(1);
    }
    prodTmpPath = tmp;
    loadEnvFile(tmp);
}

function cleanupProdTmp() {
    if (prodTmpPath && existsSync(prodTmpPath)) {
        try { unlinkSync(prodTmpPath); } catch { /* noop */ }
    }
}

if (PROD) pullProdEnv();
else loadEnvFile(ENV_FILE);

if (!process.env.DATABASE_URL) {
    console.error(`${RED}DATABASE_URL not set.${RESET}`);
    cleanupProdTmp();
    process.exit(1);
}

const dbHost = (() => {
    try {
        const u = new URL(process.env.DATABASE_URL);
        return `${u.hostname}${u.pathname}`;
    } catch { return "<unparseable URL>"; }
})();

const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();

if (files.length === 0) {
    console.error(`${RED}No migration files found in ${MIGRATIONS_DIR}.${RESET}`);
    cleanupProdTmp();
    process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, {
    max: 1,
    ssl: "require",
    onnotice: () => { /* suppress NOTICE chatter (e.g. "relation already exists, skipping") */ },
});

async function ensureTracker() {
    await sql.unsafe(`CREATE TABLE IF NOT EXISTS ${TRACKER} (
        tag TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function appliedTags() {
    const rows = await sql.unsafe(`SELECT tag FROM ${TRACKER}`);
    return new Set(rows.map((r) => r.tag));
}

async function printStatus() {
    const applied = await appliedTags();
    const pending = [];
    console.log(`${BOLD}DB:${RESET} ${dbHost}`);
    console.log(`${BOLD}Migrations (${files.length} total):${RESET}`);
    for (const f of files) {
        const tag = f.replace(/\.sql$/, "");
        if (applied.has(tag)) {
            console.log(`  ${GREEN}OK${RESET} ${tag}`);
        } else {
            console.log(`  ${YELLOW}--${RESET} ${tag} ${DIM}(pending)${RESET}`);
            pending.push(tag);
        }
    }
    if (pending.length === 0) console.log(`\n${GREEN}All migrations applied.${RESET}`);
    else console.log(`\n${YELLOW}${pending.length} pending.${RESET}`);
    return pending;
}

async function markApplied(pending) {
    if (pending.length === 0) {
        console.log(`${GREEN}Nothing to mark.${RESET}`);
        return;
    }
    if (!YES) {
        console.log("");
        console.log(`${YELLOW}About to mark ${pending.length} migration(s) as applied on ${BOLD}${dbHost}${RESET}${YELLOW} without running them.${RESET}`);
        console.log(`${DIM}Re-run with --yes to confirm.${RESET}`);
        return;
    }
    for (const tag of pending) {
        await sql.unsafe(`INSERT INTO ${TRACKER} (tag) VALUES ($1) ON CONFLICT DO NOTHING`, [tag]);
        console.log(`  ${CYAN}marked${RESET} ${tag}`);
    }
    console.log(`${GREEN}Done.${RESET}`);
}

async function applyPending(pending) {
    if (pending.length === 0) {
        console.log(`${GREEN}Nothing to apply.${RESET}`);
        return;
    }
    for (const tag of pending) {
        const file = `${tag}.sql`;
        const body = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        const statements = body
            .split(/-->\s*statement-breakpoint/i)
            .map((s) => s.trim())
            .filter(Boolean);
        if (DRY_RUN) {
            console.log(`${DIM}would apply${RESET} ${tag} ${DIM}(${statements.length} statement(s))${RESET}`);
            continue;
        }
        process.stdout.write(`${CYAN}applying${RESET} ${tag} ${DIM}(${statements.length} statement(s))${RESET} ... `);
        try {
            // Per-migration transaction: if ANY statement throws, the
            // whole migration (schema changes + tracker insert) rolls
            // back atomically. The throw below stops further migrations.
            // Result: either a migration is fully applied AND tracked,
            // or it's not — never half-applied/orphaned.
            await sql.begin(async (tx) => {
                for (const stmt of statements) await tx.unsafe(stmt);
                await tx.unsafe(`INSERT INTO ${TRACKER} (tag) VALUES ($1)`, [tag]);
            });
            console.log(`${GREEN}OK${RESET}`);
        } catch (e) {
            console.log(`${RED}FAIL${RESET}`);
            console.error(`  ${RED}${e.message}${RESET}`);
            throw e;
        }
    }
    console.log(`${GREEN}Done.${RESET}`);
}

try {
    await ensureTracker();
    // Postgres advisory lock: serialize concurrent migration runs across
    // processes (two devs/CI jobs hitting the same DB at once). Lock key
    // is a stable hash of "mmo-migrations" — int4 derived from arbitrary
    // string. Released when session ends (sql.end() in finally).
    const LOCK_KEY = 871234567; // stable arbitrary int for this app
    const [{ locked }] = await sql.unsafe(`SELECT pg_try_advisory_lock($1) AS locked`, [LOCK_KEY]);
    if (!locked) {
        console.error(`${RED}Another migration run is in progress (advisory lock held).${RESET} Wait and retry.`);
        process.exitCode = 1;
    } else {
        const pending = await printStatus();
        if (STATUS_ONLY) {
            // nothing more
        } else if (MARK_APPLIED) {
            await markApplied(pending);
        } else {
            await applyPending(pending);
        }
        await sql.unsafe(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]);
    }
} catch (e) {
    console.error(e.message || e);
    process.exitCode = 1;
} finally {
    await sql.end();
    cleanupProdTmp();
}
