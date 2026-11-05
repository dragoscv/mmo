#!/usr/bin/env node
/**
 * pnpm e2e:cloud — run the apps/web Playwright suite on an ephemeral GCE spot VM, never on this
 * workstation (owner rule 2026-10-11). Port of brivio scripts/e2e-cloud (ADR-0236) and the
 * studiai variant; infrastructure is brivio's runner (project brivio-488003).
 *
 *   pnpm e2e:cloud --target https://mixai.ro [playwright args…]      a deployed origin (remote)
 *   pnpm e2e:cloud --target vm-prod [playwright args…]               next build + start ON the VM
 *   pnpm e2e:cloud --target vm-prod --prod-session --companion-tunnel e2e/media-wp16.spec.ts --project=chromium
 *
 * Signed-in runs (WP16-54):
 *   --prod-session      mint a 2 h Auth.js `session` row in the DB apps/web/.env.local points at
 *                       (PRODUCTION) for the user that owns the local companion's device row, pass the
 *                       token as E2E_SESSION_COOKIE, and DELETE that row when the run ends (finally).
 *   --companion-tunnel  make sure the local MMO Server (:17899) runs (starts scripts/run-companion-local.ps1
 *                       when it does not answer, stops it afterwards), open a Cloudflare quick tunnel to it,
 *                       and forward 127.0.0.1:17899 on the VM to that tunnel (companion-forward.mjs). The
 *                       paired device row keeps its loopback api_url → no write to `devices`.
 *
 * vm-prod env = a WHITELIST read from apps/web/.env.local (never the whole file): DATABASE_URL + AUTH_SECRET
 * (session lookup + device-token decrypt). Every shipped key name is printed; values never are. The env
 * object is deleted from the bucket by the VM as soon as it is read.
 *
 * Other options: --machine <type> (default n2d-standard-16), --zone, --keep (VM is not deleted),
 * --no-wait, --attach <runId>, --out <dir> (where report/results land; default apps/web), --ledger.
 * Exit code = Playwright's exit code on the VM.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB = join(ROOT, "apps/web");
const TMP = join(ROOT, ".copilot-tmp/e2e-cloud");
const LEDGER = join(TMP, "ledger.jsonl");
const PROJECT = process.env.MMO_E2E_PROJECT ?? "brivio-488003";
const BUCKET = `brivio-e2e-runs-${PROJECT}`;
const SA = `brivio-e2e-runner@${PROJECT}.iam.gserviceaccount.com`;
const IMAGE_FAMILY = "brivio-e2e-runner";
const VM_PREFIX = "brivio-e2e-mmo-"; // the runner SA may delete ONLY brivio-e2e-* VMs (IAM condition)
const SPOT_USD_PER_HOUR = { "n2d-standard-8": 0.09, "n2d-standard-16": 0.18, "n2d-standard-32": 0.36 };
const ENV_WHITELIST = ["DATABASE_URL", "AUTH_SECRET"];
const COMPANION_PORT = 17899;

// ---------------------------------------------------------------- args --
const argv = process.argv.slice(2);
const own = new Map();
const pw = [];
const VALUED = new Set(["target", "machine", "zone", "cmd", "attach", "out"]);
const BOOL = new Set(["keep", "no-wait", "ledger", "help", "prod-session", "companion-tunnel"]);
for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m && VALUED.has(m[1])) own.set(m[1], m[2] ?? argv[++i]);
    else if (m && BOOL.has(m[1])) own.set(m[1], true);
    else pw.push(argv[i]);
}
if (own.get("help")) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
    process.exit(0);
}

function sh(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32", ...opts });
    if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}\n${r.stderr ?? ""}`);
    return (r.stdout ?? "").trim();
}
const gcloud = (args, opts) => sh("gcloud", [...args, `--project=${PROJECT}`], opts);
const gsExists = (p) =>
    spawnSync("gcloud", ["storage", "ls", p, `--project=${PROJECT}`], { shell: process.platform === "win32", stdio: "ignore" }).status === 0;
const gsCat = (p) => gcloud(["storage", "cat", p], { allowFail: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (own.get("ledger")) {
    if (!existsSync(LEDGER)) {
        console.log("no runs recorded yet");
        process.exit(0);
    }
    let usd = 0;
    for (const r of readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l))) {
        usd += r.usd ?? 0;
        console.log(`${r.at}  ${r.runId}  ${String(r.mode).padEnd(8)} ${String(r.machine).padEnd(16)} ${String(r.seconds).padStart(5)}s  $${(r.usd ?? 0).toFixed(3)}  exit=${r.exit}`);
    }
    console.log(`~$${usd.toFixed(2)} total (spot list price estimate)`);
    process.exit(0);
}

// ---------------------------------------------------------------- mode --
const target = own.get("target");
let mode;
let baseUrl = "";
if (target === "vm-prod") mode = "vm-prod";
else if (/^https?:\/\//.test(target ?? "")) {
    mode = "remote";
    baseUrl = target.replace(/\/$/, "");
} else if (!own.get("attach")) {
    console.error('e2e:cloud: --target must be a URL or "vm-prod"');
    process.exit(2);
}
if (!own.get("cmd") && !pw.some((a) => a.startsWith("--reporter"))) pw.push("--reporter=list,html,json");

const zone = own.get("zone") ?? "europe-central2-a";
const machine = own.get("machine") ?? "n2d-standard-16";
const cleanups = [];
let runId = own.get("attach");
let exitCode = 1;
try {
    if (!runId) {
        runId = `${new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12)}-${Math.random().toString(36).slice(2, 6)}`;
        await launch();
    }
    if (own.get("no-wait") && !own.get("attach")) exitCode = 0;
    else exitCode = await follow(runId);
} catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
} finally {
    for (const c of cleanups.reverse()) {
        try {
            await c();
        } catch (e) {
            console.error(`cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
process.exit(exitCode);

// ---------------------------------------------------------------- env --
function readEnvLocal(key) {
    const f = join(WEB, ".env.local");
    if (!existsSync(f)) return "";
    const m = new RegExp(`^${key}=["']?([^"'\\r\\n]*)`, "m").exec(readFileSync(f, "utf8"));
    return m ? m[1] : "";
}

function companionConfig() {
    return JSON.parse(readFileSync(join(process.env.APPDATA ?? "", "mixai-companion-headless", "config.json"), "utf8"));
}

/** postgres client from apps/web's node_modules (the harness adds no dependency of its own). */
function webPostgres() {
    const require = createRequire(join(WEB, "package.json"));
    const postgres = require("postgres");
    return postgres(readEnvLocal("DATABASE_URL"), { max: 1 });
}

/** Mint a 2 h session for the owner of the companion's device row; register its deletion. */
async function mintProdSession() {
    const secret = readEnvLocal("AUTH_SECRET");
    const cfg = companionConfig();
    if (!secret || !cfg.deviceToken) throw new Error("--prod-session needs AUTH_SECRET in apps/web/.env.local and a paired local companion");
    const hk = Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), Buffer.from("mmo:device-token:hmac:v1", "utf8"), 32));
    const hash = crypto.createHmac("sha256", hk).update(cfg.deviceToken, "utf8").digest("hex");
    const sql = webPostgres();
    try {
        const [dev] = await sql`select id, user_id from devices where token_hash = ${hash} limit 1`;
        if (!dev) throw new Error("the local companion's device token matches no devices row (pair it first)");
        const token = crypto.randomUUID();
        const expires = new Date(Date.now() + 2 * 3600_000);
        await sql`insert into "session" ("sessionToken", "userId", "expires") values (${token}, ${dev.user_id}, ${expires})`;
        console.log(`  session: minted for the owner of device ${dev.id} (expires ${expires.toISOString()})`);
        cleanups.push(async () => {
            const s = webPostgres();
            try {
                const r = await s`delete from "session" where "sessionToken" = ${token}`;
                console.log(`  session: deleted sessions: ${r.count}`);
            } finally {
                await s.end();
            }
        });
        return token;
    } finally {
        await sql.end();
    }
}

async function companionHealthy() {
    try {
        const r = await fetch(`http://127.0.0.1:${COMPANION_PORT}/health`, { signal: AbortSignal.timeout(3000) });
        return r.ok ? await r.json() : null;
    } catch {
        return null;
    }
}

/** Local companion up (start it if needed) + quick tunnel; returns the trycloudflare URL. */
async function companionTunnel() {
    let health = await companionHealthy();
    if (!health) {
        console.log("  companion: not running → scripts/run-companion-local.ps1");
        sh("pwsh", ["-NoProfile", "-File", join(ROOT, "scripts/run-companion-local.ps1"), "-Media", "D:\\Movies,D:\\TV Shows,H:\\Music"], { stdio: "ignore" });
        health = await companionHealthy();
        if (!health) throw new Error("local companion did not start (see .copilot-tmp/companion-local.log)");
        cleanups.push(() => sh("pwsh", ["-NoProfile", "-File", join(ROOT, "scripts/run-companion-local.ps1"), "-Stop"], { allowFail: true }));
    }
    console.log(`  companion: ${health.version} on :${COMPANION_PORT}`);
    const bin = sh(process.platform === "win32" ? "where" : "which", ["cloudflared"]).split(/\r?\n/)[0];
    const cf = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${COMPANION_PORT}`], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    cleanups.push(() => {
        cf.kill();
        console.log(`  tunnel: cloudflared pid ${cf.pid} stopped`);
    });
    const url = await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("cloudflared printed no trycloudflare URL in 60 s")), 60_000);
        const onData = (b) => {
            const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(b.toString());
            if (m) {
                clearTimeout(t);
                res(m[0]);
            }
        };
        cf.stdout.on("data", onData);
        cf.stderr.on("data", onData);
        cf.on("exit", (c) => rej(new Error(`cloudflared exited ${c}`)));
    });
    // The new hostname needs a few seconds before the edge routes it; prove it end to end (DoH-free: the VM checks again).
    console.log(`  tunnel: ${url}`);
    return url;
}

// ---------------------------------------------------------------- launch --
async function launch() {
    mkdirSync(TMP, { recursive: true });
    const t0 = Date.now();
    const env = [];
    const shipped = [];
    if (mode === "vm-prod") {
        for (const k of ENV_WHITELIST) {
            const v = readEnvLocal(k);
            if (v) {
                env.push(`${k}=${v}`);
                shipped.push(k);
            }
        }
    }
    if (own.get("companion-tunnel")) {
        env.push(`COMPANION_TUNNEL_URL=${await companionTunnel()}`);
        shipped.push("COMPANION_TUNNEL_URL");
    }
    if (own.get("prod-session")) {
        env.push(`E2E_SESSION_COOKIE=${await mintProdSession()}`);
        shipped.push("E2E_SESSION_COOKIE");
    }

    const bundle = join(TMP, `${runId}.tgz`);
    const idx = join(TMP, `${runId}.index`);
    const genv = { ...process.env, GIT_INDEX_FILE: idx };
    const git = (a) =>
        execFileSync("git", ["-c", "core.safecrlf=false", ...a], { cwd: ROOT, env: genv, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] })
            .toString("utf8")
            .trim();
    // Working tree (tracked + untracked-not-ignored) staged into a THROWAWAY index: the shared clone's
    // real index is never touched. external/ (vendored model repos) is not needed by apps/web.
    git(["read-tree", "HEAD"]);
    git(["add", "--all", "--", "."]);
    git(["rm", "-r", "--cached", "--quiet", "--ignore-unmatch", "--", "external"]);
    const tree = git(["write-tree"]);
    const count = git(["ls-tree", "-r", "--name-only", tree]).split("\n").length;
    execFileSync("git", ["-c", "core.autocrlf=false", "archive", "--format=tar.gz", "-o", bundle, tree], { cwd: ROOT });
    rmSync(idx, { force: true });
    const mb = (readFileSync(bundle).length / 1048576).toFixed(1);
    console.log(`▶ e2e:cloud ${runId}  mode=${mode}${baseUrl ? ` → ${baseUrl}` : ""}  machine=${machine} (spot)  bundle=${count} files / ${mb} MB`);
    console.log(`  env keys shipped: ${shipped.length ? shipped.join(", ") : "(none)"}`);

    const run = `gs://${BUCKET}/mmo/runs/${runId}`;
    gcloud(["storage", "cp", "-q", bundle, `${run}/src.tgz`]);
    rmSync(bundle);
    if (env.length) {
        const envFile = join(TMP, `${runId}.env`);
        writeFileSync(envFile, env.join("\n") + "\n", { mode: 0o600 });
        try {
            gcloud(["storage", "cp", "-q", envFile, `${run}/env`]);
        } finally {
            rmSync(envFile, { force: true });
        }
        // Belt and braces: the VM deletes it on read; if the VM never boots, delete it here.
        cleanups.push(() => gcloud(["storage", "rm", "-q", `${run}/env`], { allowFail: true, stdio: "ignore" }));
    }

    const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
    const startup = join(TMP, `${runId}.startup.sh`);
    writeFileSync(startup, readFileSync(join(ROOT, "scripts/e2e-cloud/vm-run.sh"), "utf8").replace(/\r\n/g, "\n"));
    const md = [
        `run-id=${runId}`,
        `bucket=${BUCKET}`,
        `mode=${mode}`,
        `base-url=${b64(baseUrl)}`,
        `pw-args=${b64(pw.map(q).join(" "))}`,
        `cmd=${b64(own.get("cmd") ?? "")}`,
        `keep=${own.get("keep") ? "1" : "0"}`,
    ].join(",");
    gcloud([
        "compute", "instances", "create", `${VM_PREFIX}${runId}`,
        `--zone=${zone}`, `--machine-type=${machine}`,
        `--image-family=${IMAGE_FAMILY}`, `--image-project=${PROJECT}`,
        // The runner image is 100 GB; a smaller boot disk is rejected.
        "--boot-disk-size=100GB", "--boot-disk-type=pd-ssd",
        "--provisioning-model=SPOT", "--instance-termination-action=DELETE",
        "--max-run-duration=2h",
        `--service-account=${SA}`, "--scopes=cloud-platform",
        "--labels=purpose=e2e,owner=mmo",
        `--metadata=${md}`, `--metadata-from-file=startup-script=${startup}`,
    ]);
    rmSync(startup);
    console.log(`  VM ${VM_PREFIX}${runId} created in ${((Date.now() - t0) / 1000).toFixed(0)} s — re-attach: pnpm e2e:cloud --attach ${runId}`);
    if (own.get("no-wait") && cleanups.length)
        console.log("  --no-wait with --prod-session/--companion-tunnel: the session/tunnel are torn down NOW; use only without them.");
}

function q(s) {
    return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------- follow --
async function follow(id) {
    const run = `gs://${BUCKET}/mmo/runs/${id}`;
    let shown = 0;
    const started = Date.now();
    for (;;) {
        await sleep(15_000);
        const log = gsCat(`${run}/log`);
        if (log.length > shown) {
            process.stdout.write(log.slice(shown).replace(/^/gm, "  │ "));
            if (!log.endsWith("\n")) process.stdout.write("\n");
            shown = log.length;
        }
        if (gsExists(`${run}/exit-code`)) break;
        if (Date.now() - started > 2.1 * 3600_000) {
            console.error("✗ no exit-code after 2.1 h — VM hit max-run-duration or was preempted");
            return 1;
        }
    }
    const code = Number(gsCat(`${run}/exit-code`) || 1);
    const finalLog = gsCat(`${run}/log`);
    if (finalLog.length > shown) process.stdout.write(finalLog.slice(shown).replace(/^/gm, "  │ ") + "\n");
    const OUT = own.get("out") ? resolve(own.get("out")) : WEB;
    mkdirSync(OUT, { recursive: true });
    for (const obj of ["report.tgz", "results.tgz", "server-logs.tgz"]) {
        if (!gsExists(`${run}/${obj}`)) continue;
        const f = join(TMP, `${id}-${obj}`);
        gcloud(["storage", "cp", "-q", `${run}/${obj}`, f]);
        let dest = OUT;
        if (obj === "report.tgz") rmSync(join(OUT, "playwright-report"), { recursive: true, force: true });
        if (obj === "results.tgz") rmSync(join(OUT, "test-results"), { recursive: true, force: true });
        if (obj === "server-logs.tgz") {
            dest = join(OUT, "server-logs");
            mkdirSync(dest, { recursive: true });
        }
        sh("tar", ["-xzf", f, "-C", dest]);
        rmSync(f);
    }
    let meta = {};
    try {
        meta = JSON.parse(gsCat(`${run}/meta.json`));
    } catch {
        /* VM died before writing it */
    }
    const usd = ((meta.seconds ?? 0) / 3600) * (SPOT_USD_PER_HOUR[meta.machine] ?? 0.18);
    mkdirSync(TMP, { recursive: true });
    appendFileSync(LEDGER, JSON.stringify({ at: new Date().toISOString(), ...meta, usd: Number(usd.toFixed(4)) }) + "\n");
    console.log(`${code === 0 ? "✓" : "✗"} exit=${code}  ${meta.seconds ?? "?"} s on ${meta.machine ?? "?"}  ~$${usd.toFixed(3)}  phases: ${meta.phases ?? "?"}`);
    const vm = gcloud(["compute", "instances", "list", `--filter=name=${VM_PREFIX}${id}`, "--format=value(name,status)"], { allowFail: true });
    console.log(`  VM after run: ${vm || "deleted (not listed)"}`);
    return code;
}
