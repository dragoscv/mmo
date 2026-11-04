/**
 * Headless entry — runs the MMO server core as a plain Node process
 * (Docker on arm64 / Raspberry Pi, systemd, …) with no Electron shell.
 * See docs/adr/0002-mmo-server-headless-core.md.
 *
 * Env:
 *   MMO_PORT    listen port (default 17899; persisted into settings)
 *   MMO_DATA    data dir (config.json, library.db, logs)
 *   MMO_MEDIA   comma-separated folders registered as library folders on
 *               first boot when the store has none
 *   MMO_DEVICE_TOKEN  pre-set the local access token (TV/Subsonic clients,
 *               `x-device-token`). When absent and the server is unpaired a
 *               random token is generated once and stored in config.json.
 *   MMO_HEADLESS=1 disables native audio (audify) — set by the Dockerfile
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

if (!process.env.MMO_HEADLESS) process.env.MMO_HEADLESS = "1";

import { platform, runBeforeQuit } from "./platform";
import { store, getSettings, type FolderConfig, type FolderKind } from "./store";
import { startServer, stopServer } from "./server";
import { log } from "./lib/logger";

function guessKind(dir: string): FolderKind {
    const base = path.basename(dir).toLowerCase();
    if (/movie|film/.test(base)) return "movies";
    if (/tv|series|serial|show/.test(base)) return "tv-shows";
    if (/sample/.test(base)) return "samples";
    if (/record/.test(base)) return "recordings";
    return "music";
}

function applyEnv(): void {
    const port = Number(process.env.MMO_PORT);
    if (Number.isInteger(port) && port > 0 && port < 65536 && store.get("serverPort") !== port) {
        store.set("serverPort", port);
    }

    // Local access token. A headless box has no OAuth pairing flow yet, so
    // clients (MixAI TV, Subsonic apps) authenticate with this token.
    const envToken = (process.env.MMO_DEVICE_TOKEN ?? "").trim();
    const current = String(store.get("deviceToken") ?? "");
    if (envToken && envToken !== current) {
        store.set("deviceToken", envToken);
        log.info("[headless] device token set from MMO_DEVICE_TOKEN");
    } else if (!current) {
        const generated = crypto.randomBytes(24).toString("base64url");
        store.set("deviceToken", generated);
        log.info(`[headless] generated local device token — read it from ${path.join(platform.getPath("userData"), "config.json")} (key deviceToken)`);
    }
    if (!store.get("userId")) store.set("userId", "local");

    const media = (process.env.MMO_MEDIA ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    if (media.length > 0 && getSettings().scanFolders.length === 0) {
        const folders: FolderConfig[] = [];
        for (const dir of media) {
            const abs = path.resolve(dir);
            if (!fs.existsSync(abs)) { log.warn(`[headless] MMO_MEDIA folder missing, skipping: ${abs}`); continue; }
            folders.push({ path: abs, watch: true, kind: guessKind(abs) });
        }
        if (folders.length > 0) {
            store.set("scanFolders", folders);
            log.info(`[headless] registered ${folders.length} media folder(s) from MMO_MEDIA`);
        }
    }
}

async function main(): Promise<void> {
    fs.mkdirSync(platform.getPath("userData"), { recursive: true });
    applyEnv();
    const settings = getSettings();
    log.info(`[headless] mmo-server v${platform.getVersion()} data=${platform.getPath("userData")} port=${settings.serverPort}`);
    await startServer();

    let stopping = false;
    const shutdown = (signal: string) => {
        if (stopping) return;
        stopping = true;
        log.info(`[headless] ${signal} received, shutting down`);
        runBeforeQuit();
        const timer = setTimeout(() => process.exit(1), 10_000);
        stopServer()
            .then(() => { clearTimeout(timer); process.exit(0); })
            .catch((e) => { log.error("[headless] stopServer failed", e); process.exit(1); });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error("[headless] fatal:", e);
    process.exit(1);
});
