#!/usr/bin/env node
/**
 * watch-mac-sync.mjs — host-side file watcher.
 *
 * Started by `dev-on-mac.sh --watch`. Watches `server/src` and `server/ui`
 * with chokidar (forced polling because the source lives on /mnt/e DrvFs
 * which has flaky inotify). On any change, debounces 250ms then pushes
 * the affected top-level paths to the Mac VM via tar-over-ssh.
 *
 * On the Mac, `tsc --watch` rebuilds dist/ from src/, and `electronmon`
 * picks up the dist/ + ui/ change and restarts the Electron process.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, "..");

const env = process.env;
const MAC_HOST = env.MAC_HOST || "127.0.0.1";
const MAC_PORT = env.MAC_PORT || "10022";
const MAC_USER = env.MAC_USER || "dragos";
const MAC_PASS = env.MAC_PASS || "papuci123";
const MAC_DIR  = env.MAC_DIR  || "/Users/dragos/companion-dev";

// chokidar is a runtime dep of the Companion (used by the file scanner)
// so we can rely on it being installed in node_modules.
const { default: chokidar } = await import("chokidar");

const WATCHED = ["src", "ui", "assets", "package.json", "tsconfig.json"];

console.log(`[watch] watching ${WATCHED.join(", ")} under ${SERVER_ROOT}`);
console.log(`[watch] target ${MAC_USER}@${MAC_HOST}:${MAC_PORT}:${MAC_DIR}`);

/** Push the listed top-level paths to the VM via tar | ssh tar. */
function syncPaths(paths) {
    return new Promise((resolvePromise, reject) => {
        // Spawn tar locally piped into ssh on the VM. Note we use a single
        // pipeline (no &&) — the pipe is the data channel, not a sequencer.
        const cmd = `cd "${SERVER_ROOT.replace(/\\/g, "/")}" && ` +
            `tar -czf - --exclude=node_modules --exclude=dist --exclude=release ${paths.map(p => `"${p}"`).join(" ")} ` +
            `| sshpass -p "${MAC_PASS}" ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p ${MAC_PORT} ${MAC_USER}@${MAC_HOST} 'cd "${MAC_DIR}" && tar -xzf -'`;

        const child = spawn("bash", ["-c", cmd], { stdio: "inherit" });
        child.on("exit", (code) => {
            if (code === 0) resolvePromise();
            else reject(new Error(`sync exited ${code}`));
        });
    });
}

let pendingTopLevels = new Set();
let debounceTimer = null;
let inFlight = false;

function schedule(rel) {
    // Map any change inside e.g. src/foo/bar.ts to its top-level "src".
    const top = rel.split(/[\\/]/, 1)[0];
    if (!WATCHED.includes(top)) return;
    pendingTopLevels.add(top);

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, 250);
}

async function flush() {
    if (inFlight) {
        // Re-arm; another flush will run after the current one finishes.
        debounceTimer = setTimeout(flush, 100);
        return;
    }
    if (pendingTopLevels.size === 0) return;
    const batch = [...pendingTopLevels];
    pendingTopLevels.clear();
    inFlight = true;
    const t0 = Date.now();
    try {
        console.log(`[watch] sync → ${batch.join(", ")}`);
        await syncPaths(batch);
        console.log(`[watch] synced in ${Date.now() - t0}ms`);
    } catch (err) {
        console.error(`[watch] sync failed:`, err.message);
    } finally {
        inFlight = false;
        if (pendingTopLevels.size > 0) flush();
    }
}

const watcher = chokidar.watch(WATCHED.map(p => resolve(SERVER_ROOT, p)), {
    cwd: SERVER_ROOT,
    ignoreInitial: true,
    ignored: [
        /(^|[\\/])\../,         // dotfiles
        /node_modules/,
        /[\\/]dist[\\/]/,
        /[\\/]release[\\/]/,
    ],
    usePolling: true,           // /mnt/e DrvFs needs polling
    interval: 400,
    binaryInterval: 800,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
});

watcher
    .on("add",    p => schedule(p))
    .on("change", p => schedule(p))
    .on("unlink", p => schedule(p))
    .on("ready",  () => console.log("[watch] ready — edit files and they'll sync to the VM"));

process.on("SIGINT", () => {
    console.log("\n[watch] stopping");
    watcher.close().finally(() => process.exit(0));
});
