/**
 * Active layout + user layouts + snapshots. Persisted to localStorage
 * (`mixai-layout`), exported by the settings "layout" section.
 *
 * - `activeId` picks from built-ins, user layouts and installed pack layouts.
 * - `snapshots` bind a layout to a slot 1..8 (keys Alt+1..8 or a MIDI pad):
 *   switching morphs the shell (Motion layout animation).
 * - `controllerLayouts` maps a controller name (BLE/MIDI/HID device name) to a
 *   layout id that is applied automatically when it connects.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { BUILTIN_LAYOUTS, CLASSIC, DEFAULT_LAYOUT } from "./presets.ts";
import { validateLayout } from "./solver.ts";
import { PANEL_IDS, type LayoutDoc } from "./types.ts";
import { remapLegacyRef } from "../packs/pack-layouts.ts";

const KEY = "mixai-layout";
/** Set once the 1.5 default-layout migration ran (see `migrateDefaultLayout`). */
const MIGRATED_KEY = "mixai-layout-v2";

export interface PersistedLayout {
    activeId: string;
    user: LayoutDoc[];
    snapshots: Record<string, string>; // "1".."8" -> layout id
    controllerLayouts: Record<string, string>; // device name -> layout id
}

const EMPTY: PersistedLayout = { activeId: DEFAULT_LAYOUT.id, user: [], snapshots: {}, controllerLayouts: {} };

/**
 * Decks 1.5 changed the default layout from Classic to Pro. An install that is still on the
 * old default moves once (`migrated` false); any other choice is kept. Pure for tests.
 */
export function migrateDefaultLayout(s: PersistedLayout, migrated: boolean): PersistedLayout {
    if (migrated || s.activeId !== CLASSIC.id) return s;
    return { ...s, activeId: DEFAULT_LAYOUT.id };
}

/** Parse a persisted/imported blob; invalid user layouts are dropped. */
export function parseLayoutState(raw: unknown): PersistedLayout {
    if (!raw || typeof raw !== "object") return { ...EMPTY };
    const r = raw as Partial<PersistedLayout>;
    const user = Array.isArray(r.user) ? r.user.filter((l) => validateLayout(l, PANEL_IDS).length === 0) : [];
    const strMap = (m: unknown) =>
        m && typeof m === "object"
            ? Object.fromEntries(Object.entries(m as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>
            : {};
    return {
        activeId: typeof r.activeId === "string" ? r.activeId : DEFAULT_LAYOUT.id,
        user,
        snapshots: strMap(r.snapshots),
        controllerLayouts: strMap(r.controllerLayouts),
    };
}

function load(): PersistedLayout {
    try {
        const raw = localStorage.getItem(KEY);
        const parsed = parseLayoutState(JSON.parse(raw ?? "null"));
        const migrated = localStorage.getItem(MIGRATED_KEY) !== null;
        if (!migrated) localStorage.setItem(MIGRATED_KEY, "1");
        const next = migrateDefaultLayout(parsed, migrated);
        if (next !== parsed) save(next);
        return next;
    } catch {
        return { ...EMPTY };
    }
}

function save(s: PersistedLayout): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
        // storage unavailable: non-fatal
    }
}

/** Move bare pack-layout refs (Decks 1.3.0) to `<packId>/<id>` given the current pack layouts. */
export function remapRefs(s: PersistedLayout, packLayouts: readonly LayoutDoc[]): PersistedLayout {
    if (packLayouts.length === 0) return s;
    const own = new Set([...BUILTIN_LAYOUTS, ...s.user].map((l) => l.id));
    const fix = (ref: string) => remapLegacyRef(ref, own, packLayouts);
    const fixMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fix(v)]));
    return { ...s, activeId: fix(s.activeId), snapshots: fixMap(s.snapshots), controllerLayouts: fixMap(s.controllerLayouts) };
}

interface LayoutStore extends PersistedLayout {
    /** Layouts contributed by installed packs (set by the pack store). */
    packLayouts: LayoutDoc[];
    all: () => LayoutDoc[];
    active: () => LayoutDoc;
    /**
     * Switch layout. `persist: false` = show it without saving (a preview, e.g. the skin
     * editor): storage keeps the user's layout, so a reload during the preview comes back to it.
     */
    setActive: (id: string, opts?: { persist?: boolean }) => void;
    saveUser: (l: LayoutDoc) => string[];
    removeUser: (id: string) => void;
    setSnapshot: (slot: string, id: string | null) => void;
    setControllerLayout: (device: string, id: string | null) => void;
    setPackLayouts: (ls: LayoutDoc[]) => void;
    /** Replace persisted state (settings import / cloud profile). */
    restore: (s: PersistedLayout) => void;
    snapshot: () => PersistedLayout;
}

export const useLayoutStore = create<LayoutStore>((set, get) => {
    /** The saved layout id while a preview shows another one (null = no preview). */
    let held: string | null = null;
    const commit = (patch: Partial<PersistedLayout>) => {
        // A layout chosen for real (picker, import, removed layout) ends any preview.
        if (patch.activeId !== undefined) held = null;
        set(patch);
        const { activeId, user, snapshots, controllerLayouts } = get();
        save({ activeId: held ?? activeId, user, snapshots, controllerLayouts });
    };
    return {
        ...load(),
        packLayouts: [],
        all: () => [...BUILTIN_LAYOUTS, ...get().user, ...get().packLayouts],
        active: () => get().all().find((l) => l.id === get().activeId) ?? DEFAULT_LAYOUT,
        setActive: (activeId, opts) => {
            if (opts?.persist === false) {
                held ??= get().activeId;
                // Back on the saved layout: nothing is held any more.
                if (held === activeId) held = null;
                set({ activeId });
                return;
            }
            commit({ activeId });
        },
        saveUser: (l) => {
            const errs = validateLayout(l, PANEL_IDS);
            if (errs.length) return errs;
            if (BUILTIN_LAYOUTS.some((b) => b.id === l.id)) return ["id is reserved by a built-in layout"];
            commit({ user: [...get().user.filter((u) => u.id !== l.id), l] });
            return [];
        },
        removeUser: (id) => commit({ user: get().user.filter((u) => u.id !== id), ...(get().activeId === id ? { activeId: DEFAULT_LAYOUT.id } : {}) }),
        setSnapshot: (slot, id) => {
            const snapshots = { ...get().snapshots };
            if (id) snapshots[slot] = id;
            else delete snapshots[slot];
            commit({ snapshots });
        },
        setControllerLayout: (device, id) => {
            const controllerLayouts = { ...get().controllerLayouts };
            if (id) controllerLayouts[device] = id;
            else delete controllerLayouts[device];
            commit({ controllerLayouts });
        },
        setPackLayouts: (packLayouts) => {
            set({ packLayouts });
            // Decks 1.3.0 referenced pack layouts by their bare id; move refs to `<packId>/<id>`.
            const cur = get().snapshot();
            const next = remapRefs(cur, packLayouts);
            if (JSON.stringify(next) !== JSON.stringify(cur)) commit(next);
        },
        // Imports / cloud profiles from 1.3.0 may carry bare pack-layout refs too.
        restore: (s) => commit(remapRefs(parseLayoutState(s), get().packLayouts)),
        snapshot: () => {
            const { activeId, user, snapshots, controllerLayouts } = get();
            // A preview is not the user's choice: exports and the cloud profile get the saved layout.
            return { activeId: held ?? activeId, user, snapshots, controllerLayouts };
        },
    };
});

/**
 * All layouts (built-in + user + packs) as a React-stable array. Never select
 * `s.all()` in a component: it returns a new array every call and React's
 * useSyncExternalStore loops ("getSnapshot should be cached").
 */
export function useAllLayouts(): LayoutDoc[] {
    const user = useLayoutStore((s) => s.user);
    const packLayouts = useLayoutStore((s) => s.packLayouts);
    return useMemo(() => [...BUILTIN_LAYOUTS, ...user, ...packLayouts], [user, packLayouts]);
}
