/**
 * Installed packs + active skin + 30 s try-before-install.
 *
 * - Installed packs come from Rust (`pack_list`), already verified.
 * - The active skin's tokens are rendered by tokensToCss into <style id="mixai-skin">
 *   and `data-skin` on <html>; theme dimensions go through the shared prefs.
 * - Layouts inside packs are validated again (TS validator) and handed to the layout store.
 * - Try: apply an inspected (not installed) pack for 30 s, then revert to the
 *   previous skin unless the user keeps it (installs).
 * - Pro packs: the download route on mixai.ro checks the decks_pro entitlement; a pro
 *   pack that reached us through it is installable. Packs from a local file marked pro
 *   need `proEntitled` (set after any successful pro download).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { packs, type PackInfo } from "@/bridge/packs";
import { applyPrefs, emitPrefsChanged, loadPrefs, savePrefs } from "@mmo/ui/theme";
import { useLayoutStore } from "@/layout/layout-store";
import { validateLayout } from "@/layout/solver";
import { PANEL_IDS, type LayoutDoc } from "@/layout/types";
import { tokensToCss } from "./apply-tokens";
import { BUILTIN_SKINS } from "./builtin-skins";

const KEY = "mixai-skin";
export const TRY_MS = 30_000;

export interface TryState {
    pack: PackInfo;
    bytes: Uint8Array | null;
    fromMarket: boolean;
    endsAt: number;
    previous: string | null;
    /** Theme prefs before the try started (restored on revert). */
    previousPrefs: ReturnType<typeof loadPrefs>;
}

interface PackStore {
    installed: PackInfo[];
    activeSkin: string | null;
    trying: TryState | null;
    proEntitled: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    setActiveSkin: (id: string | null) => void;
    /** `fromMarket`: bytes came from the entitlement-checked download route. */
    install: (bytes: Uint8Array, opts?: { fromMarket?: boolean }) => Promise<PackInfo | null>;
    remove: (id: string) => Promise<void>;
    startTry: (pack: PackInfo, bytes: Uint8Array | null, opts?: { fromMarket?: boolean }) => void;
    keepTry: () => Promise<void>;
    endTry: () => void;
    setProEntitled: (on: boolean) => void;
}

function skinById(id: string | null, installed: PackInfo[]): PackInfo | null {
    if (!id) return null;
    return BUILTIN_SKINS.find((s) => s.manifest.id === id) ?? installed.find((p) => p.manifest.id === id) ?? null;
}

/** Render a pack's tokens (or clear the skin). `persist: false` = preview only (try mode). */
export function renderSkin(pack: PackInfo | null, opts: { persist?: boolean } = {}): void {
    if (typeof document === "undefined") return;
    let el = document.getElementById("mixai-skin") as HTMLStyleElement | null;
    if (!pack?.tokens) {
        el?.remove();
        delete document.documentElement.dataset.skin;
        return;
    }
    const { css, prefs } = tokensToCss(pack.tokens, pack.assets ?? {}, pack.manifest.fonts ?? []);
    if (!el) {
        el = document.createElement("style");
        el.id = "mixai-skin";
        document.head.appendChild(el);
    }
    el.textContent = css;
    document.documentElement.dataset.skin = pack.manifest.id;
    if (Object.keys(prefs).length) {
        const next = { ...loadPrefs(), ...prefs };
        if (opts.persist !== false) savePrefs(next);
        applyPrefs(next);
        emitPrefsChanged(next);
    }
}

function packLayouts(list: PackInfo[]): LayoutDoc[] {
    const out: LayoutDoc[] = [];
    for (const p of list) for (const l of p.layouts ?? []) if (validateLayout(l, PANEL_IDS).length === 0) out.push(l as LayoutDoc);
    return out;
}

function readActive(): string | null {
    try {
        return localStorage.getItem(KEY);
    } catch {
        return null;
    }
}

let tryTimer: ReturnType<typeof setTimeout> | null = null;

export const usePackStore = create<PackStore>((set, get) => ({
    installed: [],
    activeSkin: readActive(),
    trying: null,
    proEntitled: false,
    error: null,
    refresh: async () => {
        try {
            const list = (await packs.list()) ?? [];
            set({ installed: list, error: null });
            useLayoutStore.getState().setPackLayouts(packLayouts(list));
            if (!get().trying) renderSkin(skinById(get().activeSkin, list));
        } catch (e) {
            set({ error: String(e) });
        }
    },
    setActiveSkin: (id) => {
        // Picking a skin ends any try (keep the user's choice; no revert).
        if (tryTimer) clearTimeout(tryTimer);
        tryTimer = null;
        if (get().trying) set({ trying: null });
        try {
            if (id) localStorage.setItem(KEY, id);
            else localStorage.removeItem(KEY);
        } catch {
            // storage unavailable
        }
        set({ activeSkin: id });
        renderSkin(skinById(id, get().installed));
    },
    install: async (bytes, opts = {}) => {
        try {
            const info = await packs.inspect(bytes);
            if (info?.manifest.pro && opts.fromMarket) set({ proEntitled: true });
            else if (info?.manifest.pro && !get().proEntitled) {
                set({ error: "pro" });
                return null;
            }
            const done = await packs.install(bytes);
            await get().refresh();
            set({ error: null });
            return done;
        } catch (e) {
            set({ error: String(e) });
            return null;
        }
    },
    remove: async (id) => {
        try {
            await packs.remove(id);
            if (get().activeSkin === id) get().setActiveSkin(null);
            await get().refresh();
        } catch (e) {
            set({ error: String(e) });
        }
    },
    startTry: (pack, bytes, opts = {}) => {
        if (tryTimer) clearTimeout(tryTimer);
        const cur = get().trying;
        const previous = cur?.previous ?? get().activeSkin;
        const previousPrefs = cur?.previousPrefs ?? loadPrefs();
        set({ trying: { pack, bytes, fromMarket: Boolean(opts.fromMarket), endsAt: Date.now() + TRY_MS, previous, previousPrefs } });
        renderSkin(pack, { persist: false });
        tryTimer = setTimeout(() => get().endTry(), TRY_MS);
    },
    keepTry: async () => {
        const t = get().trying;
        if (!t) return;
        if (tryTimer) clearTimeout(tryTimer);
        const builtin = BUILTIN_SKINS.some((s) => s.manifest.id === t.pack.manifest.id);
        if (!builtin && t.bytes) {
            const ok = await get().install(t.bytes, { fromMarket: t.fromMarket });
            if (!ok) {
                get().endTry();
                return;
            }
        }
        set({ trying: null });
        get().setActiveSkin(t.pack.manifest.id);
    },
    endTry: () => {
        const t = get().trying;
        if (tryTimer) clearTimeout(tryTimer);
        tryTimer = null;
        set({ trying: null });
        if (!t) return;
        // loadPrefs() still holds the pre-try prefs (try never saved); re-apply them.
        applyPrefs(t.previousPrefs);
        emitPrefsChanged(t.previousPrefs);
        renderSkin(skinById(t.previous, get().installed), { persist: false });
    },
    setProEntitled: (proEntitled) => set({ proEntitled }),
}));

/** Load installed packs once at startup and render the active skin. */
export function usePackSync(): void {
    useEffect(() => {
        renderSkin(skinById(usePackStore.getState().activeSkin, []));
        void usePackStore.getState().refresh();
    }, []);
}
