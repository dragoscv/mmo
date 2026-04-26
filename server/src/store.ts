import Store from "electron-store";

export interface CompanionSettings {
    startAtLogin: boolean;
    closeToTray: boolean;
    startMinimized: boolean;
    serverPort: number;
    scanFolders: string[];
    webAppUrl: string;
    /** Origins allowed to call the public /audio/native/* routes without
     *  a device token. Loopback origins are always allowed. Supports
     *  wildcards in the form "https://*.example.com". */
    audioOriginAllowlist: string[];
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
};

export const store = new Store({
    defaults: {
        ...DEFAULTS,
        deviceToken: "",
        deviceId: "",
        userName: "",
        userEmail: "",
        userImage: "",
    },
});

export function getSettings(): CompanionSettings {
    return {
        startAtLogin: store.get("startAtLogin") as boolean,
        closeToTray: store.get("closeToTray") as boolean,
        startMinimized: store.get("startMinimized") as boolean,
        serverPort: store.get("serverPort") as number,
        scanFolders: store.get("scanFolders") as string[],
        webAppUrl: store.get("webAppUrl") as string,
        audioOriginAllowlist: (store.get("audioOriginAllowlist") as string[] | undefined) ?? DEFAULTS.audioOriginAllowlist,
    };
}

export function updateSettings(patch: Partial<CompanionSettings>) {
    for (const [key, value] of Object.entries(patch)) {
        store.set(key, value);
    }
}
