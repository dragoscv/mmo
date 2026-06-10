#!/usr/bin/env node
/**
 * Pre-commit guard for Drizzle migrations.
 *
 * If any file under apps/web/src/db/ is staged (typically schema.ts),
 * require that the commit also stages:
 *   - at least one new SQL file under apps/web/drizzle/ (e.g. 0015_*.sql), and
 *   - an update to apps/web/drizzle/meta/_journal.json registering it.
 *
 * Usage:
 *   node apps/web/scripts/check-migrations.mjs            # check vs origin/main
 *   node apps/web/scripts/check-migrations.mjs --staged   # check staged changes (hook mode)
 *   node apps/web/scripts/check-migrations.mjs --base=<ref>
 */

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const args = process.argv.slice(2);
const STAGED = args.includes("--staged");
const baseArg = args.find((a) => a.startsWith("--base="));
const BASE = baseArg ? baseArg.slice("--base=".length) : "origin/main";

const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const RESET = "\u001b[0m";

function exec(cmd, a) {
    try {
        return execFileSync(cmd, a, {
            cwd: REPO_ROOT,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch {
        return null;
    }
}

function changedFiles() {
    if (STAGED) {
        const out = exec("git", ["diff", "--cached", "--name-only"]) ?? "";
        return out.split(/\r?\n/).filter(Boolean);
    }
    const baseOk = exec("git", ["rev-parse", "--verify", BASE]);
    if (!baseOk) {
        const out = exec("git", ["status", "--porcelain"]) ?? "";
        return out.split(/\r?\n/).map((l) => l.slice(3)).filter(Boolean);
    }
    const out = exec("git", ["diff", "--name-only", `${BASE}...HEAD`]) ?? "";
    return out.split(/\r?\n/).filter(Boolean);
}

function changedStatus() {
    // Map path -> status letter (A, M, D, R, ...).
    if (STAGED) {
        const out = exec("git", ["diff", "--cached", "--name-status"]) ?? "";
        const m = new Map();
        for (const line of out.split(/\r?\n/)) {
            const parts = line.split(/\t/);
            if (parts.length >= 2) m.set(parts[parts.length - 1], parts[0][0]);
        }
        return m;
    }
    return new Map();
}

const files = changedFiles();
const status = changedStatus();

const schemaChanged = files.some(
    (p) => p.startsWith("apps/web/src/db/") && /\.(ts|sql)$/.test(p),
);
if (!schemaChanged) {
    process.exit(0);
}

const newMigrations = files.filter((p) => {
    if (!/^apps\/web\/drizzle\/\d{4}_[^/]+\.sql$/.test(p)) return false;
    if (!STAGED) return true;
    return status.get(p) === "A";
});

if (newMigrations.length > 0) {
    console.log(
        `${GREEN}✓${RESET} Schema changes include a new migration (${newMigrations
            .map((p) => p.replace(/^apps\/web\/drizzle\//, ""))
            .join(", ")}).`,
    );
    process.exit(0);
}

console.error("");
console.error(`${RED}${BOLD}✖ Migration guard failed.${RESET}`);
console.error("");
console.error(
    `  You changed ${BOLD}apps/web/src/db/${RESET} (schema) but did not stage a matching migration.`,
);
console.error("");
console.error(`  ${BOLD}Schema files in this change:${RESET}`);
for (const p of files.filter((p) => p.startsWith("apps/web/src/db/"))) {
    console.error(`    ${DIM}-${RESET} ${p}`);
}
console.error("");
console.error(`  ${BOLD}Required:${RESET}`);
console.error(
    `    ${DIM}-${RESET} A new file ${YELLOW}apps/web/drizzle/XXXX_<name>.sql${RESET}`,
);
console.error("");
console.error(`  ${BOLD}Fix:${RESET}`);
console.error(`    cd apps/web && pnpm db:generate   ${DIM}# scaffolds the SQL file${RESET}`);
console.error(`    git add apps/web/drizzle`);
console.error("");
console.error(
    `  ${DIM}(If this commit truly does not need a migration, e.g. comments-only changes,`,
);
console.error(
    `   move them out of apps/web/src/db/ or commit with ${BOLD}--no-verify${RESET}${DIM}.)${RESET}`,
);
console.error("");
process.exit(1);
