import Store from "electron-store";

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

/**
 * A music folder configured on this companion. Stored shape evolved from
 * `string` → `{ path, watch? }` so older installs are migrated on read.
 */
export interface FolderConfig {
    path: string;
    /** When true, a chokidar watcher streams add/change events into the
     *  scan ingestion pipeline so newly-dropped files appear in the
     *  library without an explicit re-scan. */
    watch?: boolean;
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
};

export const store = new Store({
    defaults: {
        ...DEFAULTS,
        deviceToken: "",
        deviceId: "",
        userId: "",
        userName: "",
        userEmail: "",
        userImage: "",
    },
});

/** Reads scanFolders, migrating legacy `string[]` entries on the fly. */
function readScanFolders(): FolderConfig[] {
    const raw = store.get("scanFolders") as unknown;
    if (!Array.isArray(raw)) return [];
    const out: FolderConfig[] = [];
    for (const entry of raw) {
        if (typeof entry === "string") {
            out.push({ path: entry, watch: false });
        } else if (entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string") {
            out.push({
                path: (entry as { path: string }).path,
                watch: !!(entry as { watch?: boolean }).watch,
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
    return {
        startAtLogin: store.get("startAtLogin") as boolean,
        closeToTray: store.get("closeToTray") as boolean,
        startMinimized: store.get("startMinimized") as boolean,
        serverPort: healServerPort(store.get("serverPort")),
        scanFolders: readScanFolders(),
        // Respect the value the OAuth flow persisted (or that the user typed in
        // settings). Heals legacy `localhost:3000` values left over from
        // pairings made before the web app moved to port 13789.
        webAppUrl: healWebAppUrl(store.get("webAppUrl") as string | undefined),
        audioOriginAllowlist: mergeAllowlistWithDefaults(store.get("audioOriginAllowlist") as string[] | undefined),
        authorizedAudioDevices: (store.get("authorizedAudioDevices") as AuthorizedAudioDevice[] | undefined) ?? [],
        telemetryEnabled: (store.get("telemetryEnabled") as boolean | undefined) ?? DEFAULTS.telemetryEnabled,
    };
}

export function updateSettings(patch: Partial<CompanionSettings>) {
    for (const [key, value] of Object.entries(patch)) {
        store.set(key, value);
    }
}
