/**
 * Live side of the settings file: gather sections from the stores and apply
 * sections back (validated per store). Pure format logic is in settings-io.ts.
 */
import { normalizePrefs } from "@mmo/design-tokens";
import { applyPrefs, emitPrefsChanged, loadPrefs, savePrefs } from "@mmo/ui/theme";
import { engine } from "@/bridge/engine";
import type { MidiPreset, RoutingConfig } from "@/bridge/types";
import { useUiStore, type SettingsTab } from "@/state/ui-store";
import { useCompanionStore } from "@/state/companion-store";
import { useHidStore } from "@/state/hid-store";
import { useKeybindStore } from "@/state/keybind-store";
import { usePerfStore } from "@/state/perf-store";
import { usePluginStore } from "@/plugins/plugin-store";
import { useLayoutStore, parseLayoutState } from "@/layout/layout-store";
import { DEFAULT_LAYOUT } from "@/layout/presets";
import { importPreset } from "@/lib/midi-preset";
import { emptyHidPreset, importHidPreset } from "@/lib/hid-mapping";
import { DEFAULT_ROUTING, applyRouting } from "@/lib/perf";
import { resetHidFeedback } from "@/lib/hid-feedback";
import { SHELL_DEFAULTS, useShellPrefs } from "@/shell/shell-prefs";
import { usePackStore } from "@/packs/pack-store";
import { SECTION_IDS, joinAppearance, splitAppearance, toJson, type JsonValue, type SectionId, type Sections } from "./settings-io";

/** Which file sections a settings tab owns (reset + export grouping). */
export const TAB_SECTIONS: Partial<Record<SettingsTab, SectionId[]>> = {
    appearance: ["appearance"],
    layout: ["layout"],
    audio: ["audio"],
    controllers: ["midi", "hid"],
    keyboard: ["keyboard"],
    library: ["library"],
    plugins: ["plugins"],
};

const COMPANION_DEFAULT_URL = "http://127.0.0.1:17899";

function obj(v: JsonValue | undefined): Record<string, JsonValue> | null {
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

/** Snapshot the live state. `library` only with `includeLibrary`. */
export async function collect(opts: { includeLibrary?: boolean } = {}): Promise<Sections> {
    const midi = await engine.midiGetPreset().catch(() => null);
    const plugins = usePluginStore.getState();
    const comp = useCompanionStore.getState();
    const s: Sections = {
        appearance: joinAppearance({ prefs: loadPrefs(), shell: useShellPrefs.getState().snapshot(), skin: usePackStore.getState().activeSkin }),
        layout: toJson({ deckCount: useUiStore.getState().deckCount, state: useLayoutStore.getState().snapshot() }) ?? null,
        audio: toJson({ routing: usePerfStore.getState().routing }) ?? null,
        midi: toJson(midi ?? null) ?? null,
        hid: toJson(useHidStore.getState().preset) ?? null,
        keyboard: toJson(useKeybindStore.getState().overrides) ?? {},
        plugins: toJson({ external: plugins.externalSpecs, enabled: plugins.enabled }) ?? null,
    };
    if (opts.includeLibrary) s.library = { baseUrl: comp.baseUrl, deviceToken: comp.deviceToken, userId: comp.userId };
    return s;
}

function applyAppearance(v: JsonValue): void {
    const parts = splitAppearance(v);
    if (parts.skin !== undefined) {
        const packs = usePackStore.getState();
        if (packs.trying) packs.endTry();
        packs.setActiveSkin(parts.skin);
    }
    // Skin first: rendering a skin writes its theme dimensions; explicit prefs in the file win.
    const prefs = normalizePrefs({ ...loadPrefs(), ...parts.prefs });
    savePrefs(prefs);
    applyPrefs(prefs);
    emitPrefsChanged(prefs);
    if (parts.shell) {
        const shell = useShellPrefs.getState();
        shell.restore({ ...parts.shell, onboarded: shell.onboarded });
    }
}

function applyLayout(v: JsonValue): void {
    const o = obj(v);
    if (!o) return;
    if (o.deckCount === 2 || o.deckCount === 4) useUiStore.getState().restoreProfile({ deckCount: o.deckCount });
    if (obj(o.state)) useLayoutStore.getState().restore(parseLayoutState(o.state));
}

function applyAudio(v: JsonValue): void {
    const routing = obj(obj(v)?.routing);
    if (!routing) return;
    const next = applyRouting(DEFAULT_ROUTING, routing as unknown as Partial<RoutingConfig>);
    usePerfStore.getState().patchRouting(next);
}

async function applyMidi(v: JsonValue): Promise<void> {
    const preset: MidiPreset = (v && importPreset(JSON.stringify(v))) || { name: "Custom mapping", mappings: [] };
    await engine.midiSetPreset(preset);
}

function applyHid(v: JsonValue): void {
    const preset = (v && importHidPreset(JSON.stringify(v))) || emptyHidPreset();
    useHidStore.getState().setPreset(preset);
    resetHidFeedback();
}

function applyPlugins(v: JsonValue): void {
    const o = obj(v);
    if (!o) return;
    const store = usePluginStore.getState();
    if (Array.isArray(o.external)) {
        const wanted = o.external.map((x) => obj(x)).filter((x): x is Record<string, JsonValue> => x !== null);
        const wantedIds = new Set(wanted.map((x) => String(x.id)));
        for (const spec of store.externalSpecs) if (!wantedIds.has(spec.id)) store.removeExternal(spec.id);
        for (const spec of wanted) usePluginStore.getState().installExternal(JSON.stringify(spec));
    }
    if (Array.isArray(o.enabled)) {
        const on = new Set(o.enabled.filter((x): x is string => typeof x === "string"));
        const s = usePluginStore.getState();
        for (const p of s.plugins) {
            if (on.has(p.id) && !s.isEnabled(p.id)) s.enable(p.id);
            else if (!on.has(p.id) && s.isEnabled(p.id)) s.disable(p.id);
        }
    }
}

function applyLibrary(v: JsonValue): void {
    const o = obj(v);
    if (!o || typeof o.baseUrl !== "string") return;
    useCompanionStore.getState().update({
        baseUrl: o.baseUrl,
        deviceToken: typeof o.deviceToken === "string" ? o.deviceToken : "",
        userId: typeof o.userId === "string" ? o.userId : "",
    });
}

/** Apply the given sections (absent sections stay untouched). */
export async function apply(sections: Sections): Promise<void> {
    for (const id of SECTION_IDS) {
        const v = sections[id];
        if (v === undefined) continue;
        switch (id) {
            case "appearance":
                applyAppearance(v);
                break;
            case "layout":
                applyLayout(v);
                break;
            case "audio":
                applyAudio(v);
                break;
            case "midi":
                await applyMidi(v);
                break;
            case "hid":
                applyHid(v);
                break;
            case "keyboard":
                useKeybindStore.getState().setOverrides(Object.fromEntries(Object.entries(obj(v) ?? {}).filter(([, x]) => typeof x === "string")) as Record<string, string>);
                break;
            case "plugins":
                applyPlugins(v);
                break;
            case "library":
                applyLibrary(v);
                break;
        }
    }
}

/** Default values per section (reset). */
export function defaultSections(ids: readonly SectionId[]): Sections {
    const all: Record<SectionId, JsonValue> = {
        appearance: joinAppearance({ prefs: normalizePrefs({}), shell: SHELL_DEFAULTS, skin: null }),
        layout: toJson({ state: { activeId: DEFAULT_LAYOUT.id, user: useLayoutStore.getState().user, snapshots: {}, controllerLayouts: {} } }) ?? {},
        audio: toJson({ routing: DEFAULT_ROUTING }) ?? {},
        midi: null,
        hid: null,
        keyboard: {},
        plugins: { external: toJson(usePluginStore.getState().externalSpecs) ?? [], enabled: [] },
        library: { baseUrl: COMPANION_DEFAULT_URL, deviceToken: "", userId: "" },
    };
    const out: Sections = {};
    for (const id of ids) out[id] = all[id];
    return out;
}
