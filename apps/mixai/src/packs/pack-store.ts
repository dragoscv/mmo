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
 * - Gig lock: a skin try is a settings change by a door beside the Settings modal. Starting
 *   one and keeping one ask the gate (refused while locked, with the sentence); a try that
 *   runs when the lock goes on is ended at once by gig/gig-runtime (`endTry`: back to the
 *   DJ's own skin now, not when its timer runs out during the set).
 */
import { useEffect } from "react";
import { create } from "zustand";
import { normalizePrefs } from "@mmo/design-tokens";
import { packs, type PackInfo } from "@/bridge/packs";
import { gigAllows } from "@/gig/gig-store";
import { PREFS_CHANGED_EVENT, applyPrefs, emitPrefsChanged, loadPrefs, savePrefs } from "@mmo/ui/theme";
import { useLayoutStore } from "@/layout/layout-store";
import { DEFAULT_LOOK, applyLook, emitLookChanged } from "@/look/look";
import { styleLayout } from "@/look/style-vars";
import { tokensToCss } from "./apply-tokens";
import { parseBasePrefs, skinPrefsStep, type BasePrefs } from "./base-prefs";
import { BUILTIN_SKINS } from "./builtin-skins";
import { packLayoutId, packLayouts } from "./pack-layouts";

const KEY = "mixai-skin";
/**
 * The user's own value of every theme dimension the active skin overrides (restored when the
 * skin goes away). Only those dimensions: see ./base-prefs.ts.
 */
const BASE_PREFS_KEY = "mixai-skin-base-prefs";
/** Layout that was active before a skin switched it (restored when the skin goes away). */
const BASE_LAYOUT_KEY = "mixai-skin-base-layout";
export const TRY_MS = 30_000;

export interface TryState {
    pack: PackInfo;
    bytes: Uint8Array | null;
    fromMarket: boolean;
    endsAt: number;
    previous: string | null;
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
    /** Add another TRY_MS to the running try (timing adjustable, WCAG 2.2.1). */
    extendTry: () => void;
    endTry: () => void;
    setProEntitled: (on: boolean) => void;
}

function skinById(id: string | null, installed: PackInfo[]): PackInfo | null {
    if (!id) return null;
    return BUILTIN_SKINS.find((s) => s.manifest.id === id) ?? installed.find((p) => p.manifest.id === id) ?? null;
}

type Prefs = ReturnType<typeof loadPrefs>;

function readBasePrefs(): BasePrefs<Prefs> | null {
    try {
        return parseBasePrefs(localStorage.getItem(BASE_PREFS_KEY), normalizePrefs);
    } catch {
        return null;
    }
}

function writeBasePrefs(p: BasePrefs<Prefs> | null): void {
    try {
        if (p) localStorage.setItem(BASE_PREFS_KEY, JSON.stringify(p));
        else localStorage.removeItem(BASE_PREFS_KEY);
    } catch {
        // storage unavailable
    }
}

/** The prefs every listener was last told about (null = unknown: apply again). */
let shownPrefs: string | null = null;
if (typeof window !== "undefined") {
    window.addEventListener(PREFS_CHANGED_EVENT, (e) => {
        const detail = (e as CustomEvent<Prefs>).detail;
        shownPrefs = detail ? JSON.stringify(detail) : null;
    });
    // Another window saved prefs: the provider follows the storage event without an event of ours.
    window.addEventListener("storage", () => {
        shownPrefs = null;
    });
}

/**
 * Put `p` on <html> and tell the theme provider, unless that is what is already shown (a skin
 * preview renders on every frame of a colour drag; the event re-renders the whole app).
 */
function showPrefs(p: Prefs): void {
    const root = document.documentElement;
    // Trust the memo only while <html> still agrees (somebody may have applied prefs without an event).
    const onRoot = root.dataset.surface === p.surface && root.dataset.density === p.density && root.dataset.radius === p.radius && root.lang === p.locale;
    if (onRoot && JSON.stringify(p) === shownPrefs) return;
    applyPrefs(p);
    emitPrefsChanged(p);
}

/**
 * Who is previewing a skin outside the pack store (the skin editor): its "close" function.
 * While set, the store does not render over the preview; applying or trying a skin closes it first.
 */
let previewOwner: (() => void) | null = null;

export function setSkinPreviewOwner(close: (() => void) | null): void {
    previewOwner = close;
}

function closePreview(): void {
    const close = previewOwner;
    previewOwner = null;
    close?.();
}

function readBaseLayout(): string | null {
    try {
        return localStorage.getItem(BASE_LAYOUT_KEY);
    } catch {
        return null;
    }
}

function writeBaseLayout(id: string | null): void {
    try {
        if (id) localStorage.setItem(BASE_LAYOUT_KEY, id);
        else localStorage.removeItem(BASE_LAYOUT_KEY);
    } catch {
        // storage unavailable
    }
}

/**
 * The layout a skin selects, resolved to an id the layout store knows: one bundled in the same
 * pack first (`<packId>/<id>`), else a built-in / user layout. Null = the skin names none, or
 * names one that does not exist (then the current layout stays).
 */
export function skinLayoutId(pack: PackInfo | null, known: readonly string[]): string | null {
    const want = styleLayout(pack?.tokens?.style);
    if (!pack || !want) return null;
    const own = packLayoutId(pack.manifest.id, want);
    if (known.includes(own)) return own;
    return known.includes(want) ? want : null;
}

/**
 * Follow a skin change the USER made (never a startup render or a 30 s try): a skin with a
 * layout switches to it and remembers the layout it replaced; leaving such a skin brings that
 * layout back, unless the user picked another layout in the meantime.
 */
function applySkinLayout(prev: PackInfo | null, next: PackInfo | null): void {
    const ls = useLayoutStore.getState();
    const known = ls.all().map((l) => l.id);
    const prevId = skinLayoutId(prev, known);
    const nextId = skinLayoutId(next, known);
    const base = readBaseLayout();
    if (nextId) {
        // Keep the oldest base (skin A -> skin B must come back to the user's own layout),
        // unless the user picked another layout while skin A was on: then that one is theirs.
        if (!base || !prevId || ls.activeId !== prevId) writeBaseLayout(ls.activeId);
        if (ls.activeId !== nextId) ls.setActive(nextId);
        return;
    }
    if (base) {
        writeBaseLayout(null);
        // Only undo our own switch: a layout the user chose while the skin was on stays.
        if (prevId && ls.activeId === prevId && known.includes(base)) ls.setActive(base);
    }
}

/** Render a pack's tokens (or clear the skin). `persist: false` = preview only (try mode). */
export function renderSkin(pack: PackInfo | null, opts: { persist?: boolean } = {}): void {
    if (typeof document === "undefined") return;
    const persist = opts.persist !== false;
    const root = document.documentElement;
    let el = document.getElementById("mixai-skin") as HTMLStyleElement | null;
    // The user's own value of the dimensions the active skin overrides: a skin's mode / surface /
    // density / radius / accent must not outlive it. Everything else comes from the saved prefs,
    // so what the user changes in Settings while a skin is on stays changed.
    const base = readBasePrefs();
    if (!pack?.tokens) {
        el?.remove();
        delete root.dataset.skin;
        delete root.dataset.skinPlatter;
        delete root.dataset.skinWaves;
        applyLook(DEFAULT_LOOK);
        if (persist && base) {
            const { next } = skinPrefsStep(loadPrefs(), base, null);
            writeBasePrefs(null);
            savePrefs(next);
            showPrefs(next);
        }
        emitLookChanged();
        return;
    }
    const { css, prefs, look, platter, waves } = tokensToCss(pack.tokens, pack.assets ?? {}, pack.manifest.fonts ?? []);
    if (!el) {
        el = document.createElement("style");
        el.id = "mixai-skin";
        document.head.appendChild(el);
    }
    el.textContent = css;
    root.dataset.skin = pack.manifest.id;
    if (platter) root.dataset.skinPlatter = "on";
    else delete root.dataset.skinPlatter;
    if (waves === "overlay") root.dataset.skinWaves = "overlay";
    else delete root.dataset.skinWaves;
    applyLook(look);
    if (Object.keys(prefs).length || base) {
        // Start from the user's own prefs so switching skins never stacks their prefs.
        const step = skinPrefsStep(loadPrefs(), base, prefs);
        if (persist) {
            writeBasePrefs(step.base);
            savePrefs(step.next);
        }
        showPrefs(step.next);
    }
    emitLookChanged();
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
            // Built-in skins may bundle layouts too (referenced by their `style.layout`).
            useLayoutStore.getState().setPackLayouts(packLayouts([...BUILTIN_SKINS, ...list]));
            // Not over a running try or an open editor preview: they render again when they end.
            if (!get().trying && !previewOwner) renderSkin(skinById(get().activeSkin, list));
        } catch (e) {
            set({ error: String(e) });
        }
    },
    setActiveSkin: (id) => {
        // An open editor preview ends first, so "before the skin" is the user's own state.
        closePreview();
        // Picking a skin ends any try (keep the user's choice; no revert).
        if (tryTimer) clearTimeout(tryTimer);
        tryTimer = null;
        if (get().trying) set({ trying: null });
        const before = skinById(get().activeSkin, get().installed);
        try {
            if (id) localStorage.setItem(KEY, id);
            else localStorage.removeItem(KEY);
        } catch {
            // storage unavailable
        }
        set({ activeSkin: id });
        const after = skinById(id, get().installed);
        renderSkin(after);
        applySkinLayout(before, after);
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
        if (!gigAllows("changeSettings")) return;
        closePreview();
        if (tryTimer) clearTimeout(tryTimer);
        const cur = get().trying;
        const previous = cur?.previous ?? get().activeSkin;
        set({ trying: { pack, bytes, fromMarket: Boolean(opts.fromMarket), endsAt: Date.now() + TRY_MS, previous } });
        renderSkin(pack, { persist: false });
        tryTimer = setTimeout(() => get().endTry(), TRY_MS);
    },
    keepTry: async () => {
        const t = get().trying;
        if (!t) return;
        // "Keep" installs and applies the skin: refused while locked (the try itself is ended by the lock).
        if (!gigAllows("changeSettings")) return;
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
    extendTry: () => {
        const t = get().trying;
        if (!t) return;
        if (tryTimer) clearTimeout(tryTimer);
        const endsAt = Math.max(t.endsAt, Date.now()) + TRY_MS;
        set({ trying: { ...t, endsAt } });
        tryTimer = setTimeout(() => get().endTry(), endsAt - Date.now());
    },
    endTry: () => {
        const t = get().trying;
        if (tryTimer) clearTimeout(tryTimer);
        tryTimer = null;
        set({ trying: null });
        if (!t) return;
        // An editor preview that took over meanwhile owns the screen.
        if (previewOwner) return;
        // A try never saves: the saved prefs are the pre-try ones, plus whatever the user changed
        // in Settings during the try.
        showPrefs(loadPrefs());
        renderSkin(skinById(t.previous, get().installed), { persist: false });
    },
    setProEntitled: (proEntitled) => set({ proEntitled }),
}));

/**
 * Show a built-in active skin before React paints (main.tsx), so its look does not flash in
 * after the default one. Nothing is saved; installed skins wait for `usePackSync`.
 */
export function renderActiveSkinEarly(): void {
    const id = readActive();
    const builtin = id ? BUILTIN_SKINS.find((s) => s.manifest.id === id) : undefined;
    if (builtin) renderSkin(builtin, { persist: false });
}

/** Load installed packs once at startup and render the active skin. */
export function usePackSync(): void {
    useEffect(() => {
        useLayoutStore.getState().setPackLayouts(packLayouts(BUILTIN_SKINS));
        // An installed skin is not known until `refresh` answers: rendering "no skin" now would
        // drop it (and its remembered prefs) for a moment at every launch.
        const id = usePackStore.getState().activeSkin;
        const first = skinById(id, []);
        if (first || !id) renderSkin(first);
        void usePackStore.getState().refresh();
    }, []);
}
