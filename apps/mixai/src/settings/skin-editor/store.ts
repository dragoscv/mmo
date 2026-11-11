/**
 * State of the live skin editor + the preview / save / export paths.
 *
 * Preview = the pack store's own preview path: the draft becomes a `PackInfo` and goes through
 * `renderSkin(pack, { persist: false })` (the same call a 30 s try uses), so the editor shows
 * exactly what the saved skin will look like and never writes CSS of its own. Nothing is
 * persisted until "Save as my skin" (the layout a draft selects is shown without being saved
 * either); closing renders whatever the pack store says is active.
 *
 * One preview at a time: opening the editor ends a running 30 s try, and while it is open the
 * pack store does not render over it; applying or trying a skin closes the editor first
 * (`setSkinPreviewOwner`). Closing keeps unsaved edits: opening the editor again on the same
 * active skin continues the draft (Reset returns to the skin).
 */
import { create } from "zustand";
import { applyPrefs, emitPrefsChanged, loadPrefs } from "@mmo/ui/theme";
import { packs, type PackExportRequest, type PackInfo, type PackTokens } from "@/bridge/packs";
import { useLayoutStore } from "@/layout/layout-store";
import { BUILTIN_SKINS } from "@/packs/builtin-skins";
import { renderSkin, setSkinPreviewOwner, skinLayoutId, usePackStore } from "@/packs/pack-store";
import { clearEffective } from "./effective";
import { DRAFT_SKIN_ID, buildRequest, cleanTokens, nextVersion, type GroupId } from "./model";

export type EditorNote =
    | { kind: "saved"; name: string; version: string }
    | { kind: "draftKept" }
    | { kind: "exported"; path: string }
    | { kind: "exportCancelled" }
    | { kind: "notNative" }
    | { kind: "nameNeeded" }
    | { kind: "failed"; detail: string };

export interface SkinMeta {
    author: string;
    description: string;
}

interface SkinEditorState {
    open: boolean;
    setOpen: (open: boolean) => void;
    /** Tokens being edited (previewed on every change). */
    draft: PackTokens;
    /** What Reset goes back to: the tokens the editor started from, or the last saved ones. */
    start: PackTokens;
    /** Skin the draft started from (null = the default look). */
    basedOn: string | null;
    name: string;
    group: GroupId;
    /** Top-left corner of the panel in CSS px (null = default place). */
    pos: { x: number; y: number } | null;
    busy: "save" | "export" | null;
    note: EditorNote | null;
    /** The last request handed to `pack_build` / `pack_export` (kept for diagnostics). */
    lastRequest: PackExportRequest | null;
    edit: (fn: (t: PackTokens) => PackTokens) => void;
    startFrom: (id: string | null) => void;
    reset: () => void;
    setName: (name: string) => void;
    setGroup: (group: GroupId) => void;
    setPos: (pos: { x: number; y: number }) => void;
    save: (meta: SkinMeta) => Promise<boolean>;
    exportPack: (meta: SkinMeta) => Promise<boolean>;
}

function skinById(id: string | null): PackInfo | null {
    if (!id) return null;
    return BUILTIN_SKINS.find((s) => s.manifest.id === id) ?? usePackStore.getState().installed.find((p) => p.manifest.id === id) ?? null;
}

function draftPack(tokens: PackTokens): PackInfo {
    return {
        manifest: { v: 2, id: DRAFT_SKIN_ID, name: DRAFT_SKIN_ID, version: "0.0.0", kind: "skin", author: "-", description: "", pro: false },
        trust: "unsigned",
        sha256: "draft",
        size: 0,
        tokens,
    };
}

/** Layout the user had when the editor opened (or after the last save): close puts it back. */
let layoutBefore: string | null = null;
/** Active skin the current draft was started for (undefined = no draft yet). */
let draftFor: string | null | undefined;
/** Theme prefs the last preview asked for (see `preview`). */
let prefsShown = "";
let frame = 0;

/** `persist: false` while previewing: only leaving the preview (or saving) writes the layout. */
function showLayout(id: string | null, persist = true): void {
    const ls = useLayoutStore.getState();
    if (id && ls.activeId !== id && ls.all().some((l) => l.id === id)) ls.setActive(id, { persist });
}

function userPrefs(): void {
    const p = loadPrefs();
    applyPrefs(p);
    emitPrefsChanged(p);
}

function preview(draft: PackTokens): void {
    const tokens = cleanTokens(draft);
    // `renderSkin` re-applies theme prefs only when the skin sets one: a draft that just dropped
    // its mode / accent has to fall back to the user's saved prefs first.
    const sig = JSON.stringify([tokens.mode, tokens.accent, tokens.surface, tokens.density, tokens.radius]);
    if (sig !== prefsShown) {
        prefsShown = sig;
        userPrefs();
    }
    const pack = draftPack(tokens);
    renderSkin(pack, { persist: false });
    showLayout(skinLayoutId(pack, useLayoutStore.getState().all().map((l) => l.id)) ?? layoutBefore, false);
    clearEffective();
}

/** Coalesce previews to one per frame (a native colour picker fires on every pointer move). */
function schedulePreview(get: () => SkinEditorState): void {
    if (frame || typeof requestAnimationFrame === "undefined") return;
    frame = requestAnimationFrame(() => {
        frame = 0;
        if (get().open) preview(get().draft);
    });
}

/** Leave the preview: the user's prefs and layout, then whatever skin the pack store has active. */
function restore(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    prefsShown = "";
    userPrefs();
    renderSkin(skinById(usePackStore.getState().activeSkin), { persist: false });
    showLayout(layoutBefore);
    clearEffective();
}

function clone(t: PackTokens | undefined): PackTokens {
    return t ? (JSON.parse(JSON.stringify(t)) as PackTokens) : {};
}

function sameTokens(a: PackTokens, b: PackTokens): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export const useSkinEditor = create<SkinEditorState>((set, get) => ({
    open: false,
    draft: {},
    start: {},
    basedOn: null,
    name: "",
    group: "base",
    pos: null,
    busy: null,
    note: null,
    lastRequest: null,
    setOpen: (open) => {
        if (open === get().open) return;
        if (!open) {
            // `busy` is NOT cleared: a pending export is a native save dialog that is still open,
            // and forgetting it would let a second Export open a second dialog.
            // The draft stays too: see `setOpen(true)`.
            set({ open: false });
            setSkinPreviewOwner(null);
            restore();
            return;
        }
        // One preview at a time: a running try ends (back to the active skin) before ours starts.
        if (usePackStore.getState().trying) usePackStore.getState().endTry();
        const active = usePackStore.getState().activeSkin;
        layoutBefore = useLayoutStore.getState().activeId;
        prefsShown = "";
        setSkinPreviewOwner(() => get().setOpen(false));
        // Closed with unsaved edits and opened again on the same skin: continue that draft.
        if (draftFor === active && !sameTokens(get().draft, get().start)) {
            set({ open: true, note: { kind: "draftKept" } });
            preview(get().draft);
            return;
        }
        draftFor = active;
        const from = clone(skinById(active)?.tokens);
        // Editing one of the user's own skins keeps its name, so saving updates it.
        const own = active?.startsWith("user.skin.") ? (skinById(active)?.manifest.name ?? "") : "";
        set({ open: true, draft: from, start: from, basedOn: active, name: own, note: null });
        preview(from);
    },
    edit: (fn) => {
        set({ draft: fn(get().draft), note: null });
        schedulePreview(get);
    },
    startFrom: (id) => {
        const from = clone(skinById(id)?.tokens);
        set({ draft: from, start: from, basedOn: id, note: null });
        schedulePreview(get);
    },
    reset: () => {
        set({ draft: clone(get().start), note: null });
        schedulePreview(get);
    },
    setName: (name) => set({ name, note: null }),
    setGroup: (group) => set({ group }),
    setPos: (pos) => set({ pos }),
    save: async (meta) => {
        const s = get();
        if (s.busy) return false;
        const id = buildRequest(s.draft, { name: s.name, author: meta.author, version: "1.0.0" })?.id;
        const req = id ? buildRequest(s.draft, { name: s.name, ...meta, version: nextVersion(skinById(id)?.manifest.version) }) : null;
        if (!req) {
            set({ note: { kind: "nameNeeded" } });
            return false;
        }
        set({ busy: "save", note: null, lastRequest: req });
        try {
            const bytes = await packs.buildSkin(req);
            if (!bytes) {
                set({ busy: null, note: { kind: "notNative" } });
                return false;
            }
            const done = await usePackStore.getState().install(bytes);
            if (!done) {
                set({ busy: null, note: { kind: "failed", detail: usePackStore.getState().error ?? "" } });
                if (get().open) preview(get().draft);
                return false;
            }
            // Out of the preview first (user's prefs + layout), so the pack store records the
            // right "before the skin" state when it applies the saved skin for real.
            setSkinPreviewOwner(null);
            restore();
            usePackStore.getState().setActiveSkin(done.manifest.id);
            layoutBefore = useLayoutStore.getState().activeId;
            draftFor = done.manifest.id;
            if (get().open) setSkinPreviewOwner(() => get().setOpen(false));
            const saved = clone(done.tokens ?? req.tokens);
            set({ busy: null, start: saved, draft: saved, basedOn: done.manifest.id, name: done.manifest.name, note: { kind: "saved", name: done.manifest.name, version: done.manifest.version } });
            return true;
        } catch (e) {
            set({ busy: null, note: { kind: "failed", detail: String(e).replace(/^Error:\s*/, "") } });
            // The owner is cleared midway through a save; a failure after that must not leave
            // the open editor without one (the pack store could then not end its preview).
            if (get().open) setSkinPreviewOwner(() => get().setOpen(false));
            return false;
        }
    },
    exportPack: async (meta) => {
        const s = get();
        if (s.busy) return false;
        const req = buildRequest(s.draft, { name: s.name, ...meta, version: nextVersion(skinById(buildRequest(s.draft, { name: s.name, author: meta.author, version: "1.0.0" })?.id ?? null)?.manifest.version) });
        if (!req) {
            set({ note: { kind: "nameNeeded" } });
            return false;
        }
        set({ busy: "export", note: null, lastRequest: req });
        try {
            if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
                set({ busy: null, note: { kind: "notNative" } });
                return false;
            }
            const path = await packs.exportSkin(req);
            set({ busy: null, note: path ? { kind: "exported", path } : { kind: "exportCancelled" } });
            return !!path;
        } catch (e) {
            set({ busy: null, note: { kind: "failed", detail: String(e).replace(/^Error:\s*/, "") } });
            return false;
        }
    },
}));
