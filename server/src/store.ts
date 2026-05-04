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
}

const DEFAULTS: CompanionSettings = {
    startAtLogin: false,
    closeToTray: true,
    startMinimized: false,
    serverPort: 17899,
    scanFolders: [],
    webAppUrl: "http://localhost:3000",
    audioOriginAllowlist: [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://app.brivio.ro",
        "https://*.brivio.ro",
    ],
    authorizedAudioDevices: [],
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

export function getSettings(): CompanionSettings {
    return {
        startAtLogin: store.get("startAtLogin") as boolean,
        closeToTray: store.get("closeToTray") as boolean,
        startMinimized: store.get("startMinimized") as boolean,
        serverPort: store.get("serverPort") as number,
        scanFolders: readScanFolders(),
        webAppUrl: store.get("webAppUrl") as string,
        audioOriginAllowlist: (store.get("audioOriginAllowlist") as string[] | undefined) ?? DEFAULTS.audioOriginAllowlist,
        authorizedAudioDevices: (store.get("authorizedAudioDevices") as AuthorizedAudioDevice[] | undefined) ?? [],
    };
}

export function updateSettings(patch: Partial<CompanionSettings>) {
    for (const [key, value] of Object.entries(patch)) {
        store.set(key, value);
    }
}
