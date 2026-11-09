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
import { BUILTIN_LAYOUTS, CLASSIC } from "./presets.ts";
import { validateLayout } from "./solver.ts";
import { PANEL_IDS, type LayoutDoc } from "./types.ts";

const KEY = "mixai-layout";

export interface PersistedLayout {
    activeId: string;
    user: LayoutDoc[];
    snapshots: Record<string, string>; // "1".."8" -> layout id
    controllerLayouts: Record<string, string>; // device name -> layout id
}

const EMPTY: PersistedLayout = { activeId: CLASSIC.id, user: [], snapshots: {}, controllerLayouts: {} };

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
        activeId: typeof r.activeId === "string" ? r.activeId : CLASSIC.id,
        user,
        snapshots: strMap(r.snapshots),
        controllerLayouts: strMap(r.controllerLayouts),
    };
}

function load(): PersistedLayout {
    try {
        return parseLayoutState(JSON.parse(localStorage.getItem(KEY) ?? "null"));
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

interface LayoutStore extends PersistedLayout {
    /** Layouts contributed by installed packs (set by the pack store). */
    packLayouts: LayoutDoc[];
    all: () => LayoutDoc[];
    active: () => LayoutDoc;
    setActive: (id: string) => void;
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
    const commit = (patch: Partial<PersistedLayout>) => {
        set(patch);
        const { activeId, user, snapshots, controllerLayouts } = get();
        save({ activeId, user, snapshots, controllerLayouts });
    };
    return {
        ...load(),
        packLayouts: [],
        all: () => [...BUILTIN_LAYOUTS, ...get().user, ...get().packLayouts],
        active: () => get().all().find((l) => l.id === get().activeId) ?? CLASSIC,
        setActive: (activeId) => commit({ activeId }),
        saveUser: (l) => {
            const errs = validateLayout(l, PANEL_IDS);
            if (errs.length) return errs;
            if (BUILTIN_LAYOUTS.some((b) => b.id === l.id)) return ["id is reserved by a built-in layout"];
            commit({ user: [...get().user.filter((u) => u.id !== l.id), l] });
            return [];
        },
        removeUser: (id) => commit({ user: get().user.filter((u) => u.id !== id), activeId: get().activeId === id ? CLASSIC.id : get().activeId }),
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
        setPackLayouts: (packLayouts) => set({ packLayouts }),
        restore: (s) => commit(parseLayoutState(s)),
        snapshot: () => {
            const { activeId, user, snapshots, controllerLayouts } = get();
            return { activeId, user, snapshots, controllerLayouts };
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
