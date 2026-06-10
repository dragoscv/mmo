/**
 * Companion connection config (base URL, device token, muzicai.ro user id).
 *
 * Persisted to localStorage and pushed to the Rust side via
 * `engine.companionConfigure` whenever it changes, so the native HTTP proxy
 * always has current credentials. Later this will hydrate from the signed-in
 * muzicai.ro account instead of manual entry.
 */

import { create } from "zustand";
import { engine } from "@/bridge/engine";

const STORAGE_KEY = "mixai-companion";

export interface CompanionConfig {
    baseUrl: string;
    deviceToken: string;
    userId: string;
}

const DEFAULTS: CompanionConfig = {
    baseUrl: "http://127.0.0.1:17899",
    deviceToken: "",
    userId: "",
};

function load(): CompanionConfig {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        // ignore corrupt storage
    }
    return DEFAULTS;
}

function persist(cfg: CompanionConfig): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    } catch {
        // storage may be unavailable; non-fatal
    }
}

interface CompanionStore extends CompanionConfig {
    /** Update one or more fields, persist, and push to the Rust proxy. */
    update: (patch: Partial<CompanionConfig>) => void;
    /** Push the current config to the Rust proxy (call once on startup). */
    sync: () => void;
}

const initial = load();

export const useCompanionStore = create<CompanionStore>((set, get) => ({
    ...initial,
    update: (patch) => {
        const next = { ...get(), ...patch };
        set(patch);
        persist({ baseUrl: next.baseUrl, deviceToken: next.deviceToken, userId: next.userId });
        void engine.companionConfigure({
            baseUrl: next.baseUrl,
            deviceToken: next.deviceToken,
            userId: next.userId,
        });
    },
    sync: () => {
        const { baseUrl, deviceToken, userId } = get();
        void engine.companionConfigure({ baseUrl, deviceToken, userId });
    },
}));
