import Store from "electron-store";

export interface CompanionSettings {
    startAtLogin: boolean;
    closeToTray: boolean;
    startMinimized: boolean;
    serverPort: number;
    scanFolders: string[];
    webAppUrl: string;
}

const DEFAULTS: CompanionSettings = {
    startAtLogin: false,
    closeToTray: true,
    startMinimized: false,
    serverPort: 17899,
    scanFolders: [],
    webAppUrl: "http://localhost:3000",
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
    };
}

export function updateSettings(patch: Partial<CompanionSettings>) {
    for (const [key, value] of Object.entries(patch)) {
        store.set(key, value);
    }
}
