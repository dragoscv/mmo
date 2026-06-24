import Store from "electron-store";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/**
 * Stable identifier for an audio device that the user has explicitly
 * authorized for use by the web app's low-latency engine.
 *
 * We key on `name + direction` because RtAudio assigns numeric `deviceId`s
 * dynamically (they change across reboots / driver updates / hot-plug).
 * `backend` is stored as a hint so we know which API to query first
 * when resolving back to a live device.
 */
export interface AuthorizedAudioDevice {
    name: string;
    direction: "input" | "output";
    backend: string;
    /** Optional: cached preferred sample rate at time of authorization. */
    preferredSampleRate?: number;
}

/** Categorical purpose of a music folder. Drives UI grouping and (eventually)
 *  which file-type pipeline handles new files (audio scanner vs. video). */
export type FolderKind = "music" | "movies" | "tv-shows" | "samples" | "recordings" | "other";

export const FOLDER_KINDS: ReadonlyArray<FolderKind> = [
    "music", "movies", "tv-shows", "samples", "recordings", "other",
];

function normalizeFolderKind(raw: unknown): FolderKind {
    return typeof raw === "string" && (FOLDER_KINDS as readonly string[]).includes(raw)
        ? raw as FolderKind
        : "music";
}

/**
 * A music folder configured on this companion. Stored shape evolved from
 * `string` → `{ path, watch? }` → `{ path, watch?, kind? }` so older
 * installs are migrated on read.
 */
export interface FolderConfig {
    path: string;
    /** When true, a chokidar watcher streams add/change events into the
     *  scan ingestion pipeline so newly-dropped files appear in the
     *  library without an explicit re-scan. */
    watch?: boolean;
    /** Purpose of the folder (music / movies / tv-shows / …). Defaults
     *  to "music" for legacy entries that pre-date the field. */
    kind?: FolderKind;
}

export interface CompanionSettings {
    startAtLogin: boolean;
    closeToTray: boolean;
    startMinimized: boolean;
    serverPort: number;
    scanFolders: FolderConfig[];
    webAppUrl: string;
    /** Origins allowed to call the public /audio/native/* routes without
     *  a device token. Loopback origins are always allowed. Supports
     *  wildcards in the form "https://*.example.com". */
    audioOriginAllowlist: string[];
    /** Audio devices the user has explicitly opted-in to expose to the
     *  web app's low-latency engine. Empty = no devices shared. */
    authorizedAudioDevices: AuthorizedAudioDevice[];
    /** Opt-in error telemetry. When true AND a SENTRY_DSN env var is
     *  set at companion build time, `log.error()` calls forward the
     *  error to Sentry. Default `false` — the companion is self-hosted
     *  and telemetry must be explicit. */
    telemetryEnabled: boolean;
    /** When true, every video discovered by `/video/scan` is queued for
     *  background pre-remux to a sidecar `.mmo.mp4` file. The sidecar
     *  has fragment-friendly codecs (video copied, audio re-encoded to
     *  AAC stereo, +faststart) so subsequent playback can remux in
     *  realtime with near-zero CPU. Default off — the user must opt in
     *  because pre-remux writes new files into their library folders
     *  and can take a long time on big libraries. Manual single-file
     *  triggers (`POST /video/preremux/:fileId`) always work
     *  regardless of this flag. */
    preRemuxAutoOnScan: boolean;
}

const DEFAULTS: CompanionSettings = {
    startAtLogin: false,
    closeToTray: true,
    startMinimized: false,
    serverPort: 17899,
    scanFolders: [],
    webAppUrl: "https://muzicai.ro",
    audioOriginAllowlist: [
        "https://muzicai.ro",
        "https://*.muzicai.ro",
        // Local dev: web app's `next dev` / `next start` bind to 13789
        // (see app/package.json scripts). Port 3000 is intentionally NOT
        // allowed — it's the Node ecosystem default and tends to clash
        // with random unrelated services the user may be running.
        "http://localhost:13789",
        "http://127.0.0.1:13789",
    ],
    authorizedAudioDevices: [],
    telemetryEnabled: false,
    preRemuxAutoOnScan: false,
};

/**
 * One-time migration across the v1 rebrand (mmo-companion → muzicai-companion).
 *
 * Changing the Electron app/product name moved `userData` to a new directory,
 * orphaning the previous `config.json` — users lost their scan folders, device
 * pairing, tunnel token, etc., which broke audio streaming (403 "Path not in
 * allowed folders") and analyzer pairing. If the NEW config is missing or has
 * never been populated, copy the OLD one over before electron-store loads.
 *
 * Runs synchronously at import time, guarded so it only ever happens once
 * (a present, non-empty new config short-circuits it).
 */
function migrateLegacyConfigOnce(): void {
    try {
        const newDir = app.getPath("userData");
        const newCfg = path.join(newDir, "config.json");
        // Find the legacy mmo-companion userData dir as a sibling of the new one.
        const legacyCfg = path.join(path.dirname(newDir), "mmo-companion", "config.json");
        if (!fs.existsSync(legacyCfg)) return;
        const legacy = JSON.parse(fs.readFileSync(legacyCfg, "utf8"));
        if (!legacy || typeof legacy !== "object") return;

        // Read the current (new) config if any.
        let current: Record<string, unknown> = {};
        if (fs.existsSync(newCfg)) {
            try { current = JSON.parse(fs.readFileSync(newCfg, "utf8")) ?? {}; } catch { current = {}; }
        }

        // Field-level restore: fill in anything the new config is MISSING from
        // the legacy one. Critically this recovers `scanFolders` even when the
        // new install already paired (has a deviceToken) but started with empty
        // folders — the exact rebrand breakage. We never overwrite a non-empty
        // value already present in the new config.
        const RESTORE_KEYS = [
            "scanFolders", "webAppUrl", "audioOriginAllowlist", "authorizedAudioDevices",
            "telemetryEnabled", "preRemuxAutoOnScan", "startAtLogin", "closeToTray",
            "startMinimized", "serverPort", "deviceToken", "deviceId", "userId",
            "userName", "userEmail", "userImage", "tunnelToken", "tunnelHostname", "deviceName",
        ] as const;
        let changed = false;
        for (const k of RESTORE_KEYS) {
            const legacyVal = legacy[k];
            const curVal = current[k];
            const curEmpty = curVal === undefined || curVal === null || curVal === ""
                || (Array.isArray(curVal) && curVal.length === 0);
            const legacyHas = legacyVal !== undefined && legacyVal !== null && legacyVal !== ""
                && !(Array.isArray(legacyVal) && legacyVal.length === 0);
            if (curEmpty && legacyHas) { current[k] = legacyVal; changed = true; }
        }
        if (!changed) return;
        fs.mkdirSync(newDir, { recursive: true });
        fs.writeFileSync(newCfg, JSON.stringify(current, null, "\t"), "utf8");
        // eslint-disable-next-line no-console
        console.log(`[store] restored legacy settings (${legacyCfg}) into ${newCfg}`);
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[store] legacy config migration failed:", e instanceof Error ? e.message : String(e));
    }
}

migrateLegacyConfigOnce();

export const store = new Store({
    defaults: {
        ...DEFAULTS,
        deviceToken: "",
        deviceId: "",
        userId: "",
        userName: "",
        userEmail: "",
        userImage: "",
        // Cloudflare Tunnel bootstrap delivered via the announce
        // channel. Persisted so cloudflared restarts across app boots
        // without waiting for the next heartbeat.
        tunnelToken: "",
        tunnelHostname: "",
    },
});

/** Reads scanFolders, migrating legacy `string[]` entries on the fly. */
function readScanFolders(): FolderConfig[] {
    const raw = store.get("scanFolders") as unknown;
    if (!Array.isArray(raw)) return [];
    const out: FolderConfig[] = [];
    for (const entry of raw) {
        if (typeof entry === "string") {
            out.push({ path: entry, watch: false, kind: "music" });
        } else if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
            out.push({
                path: (entry as { path: string }).path,
                watch: !!(entry as { watch?: boolean }).watch,
                kind: normalizeFolderKind((entry as { kind?: unknown }).kind),
            });
        }
    }
    return out;
}

// Ensure the production muzicai.ro origins are always allowed, even when
// the user's stored allowlist was created on an older build or while
// pointing at a different webAppUrl (e.g. local dev / brivio). Without
// this, fresh deployments to muzicai.ro get CORS-blocked from the
// companion until the user manually edits settings.
function mergeAllowlistWithDefaults(stored: string[] | undefined): string[] {
    const base = stored && stored.length > 0 ? [...stored] : [];
    for (const def of DEFAULTS.audioOriginAllowlist) {
        if (!base.includes(def)) base.push(def);
    }
    return base;
}

// Stale `webAppUrl` values from older pairings (when the web app used
// Next.js's default port 3000) silently break cloud-sync — every POST
// goes to a port nothing's listening on. If we detect such a legacy
// URL we overwrite it with the production default. The user can still
// pair against a custom local dev URL afterward; we only heal the
// known-bad legacy values.
const LEGACY_WEB_APP_URLS = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3000/",
    "http://127.0.0.1:3000/",
]);

function healWebAppUrl(stored: string | undefined): string {
    if (!stored) return DEFAULTS.webAppUrl;
    if (LEGACY_WEB_APP_URLS.has(stored.trim())) {
        store.set("webAppUrl", DEFAULTS.webAppUrl);
        return DEFAULTS.webAppUrl;
    }
    return stored;
}

// Heal serverPort if it's missing, 0, or out of the valid range. A 0
// value silently bound the HTTP server to a random OS-chosen port,
// breaking every loopback probe (web app expects 17899) and turning the
// LAN beacon + mDNS broadcast into garbage. Seen in the wild when an
// older build wrote 0 to the store during a settings save edge case.
function healServerPort(stored: unknown): number {
    const n = typeof stored === "number" ? stored : Number(stored);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        store.set("serverPort", DEFAULTS.serverPort);
        return DEFAULTS.serverPort;
    }
    return n;
}

export function getSettings(): CompanionSettings {
    // Dev override: when MMO_WEB_APP_URL is set (e.g. a cloudflared quick
    // tunnel pointing at a local `pnpm dev` web server) we ignore the
    // stored value so the cloud-sync / announce / OAuth loops all target
    // local code without persisting a "localhost"-ish URL that would
    // break the next normal launch.
    const envOverride = process.env.MMO_WEB_APP_URL?.trim();
    return {
        startAtLogin: store.get("startAtLogin") as boolean,
        closeToTray: store.get("closeToTray") as boolean,
        startMinimized: store.get("startMinimized") as boolean,
        serverPort: healServerPort(store.get("serverPort")),
        scanFolders: readScanFolders(),
        // Respect the value the OAuth flow persisted (or that the user typed in
        // settings). Heals legacy `localhost:3000` values left over from
        // pairings made before the web app moved to port 13789.
        webAppUrl: envOverride || healWebAppUrl(store.get("webAppUrl") as string | undefined),
        audioOriginAllowlist: mergeAllowlistWithDefaults(store.get("audioOriginAllowlist") as string[] | undefined),
        authorizedAudioDevices: (store.get("authorizedAudioDevices") as AuthorizedAudioDevice[] | undefined) ?? [],
        telemetryEnabled: (store.get("telemetryEnabled") as boolean | undefined) ?? DEFAULTS.telemetryEnabled,
        preRemuxAutoOnScan: (store.get("preRemuxAutoOnScan") as boolean | undefined) ?? DEFAULTS.preRemuxAutoOnScan,
    };
}

export function updateSettings(patch: Partial<CompanionSettings>) {
    for (const [key, value] of Object.entries(patch)) {
        store.set(key, value);
    }
}
