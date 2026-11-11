import { Suspense, lazy, useEffect, useRef } from "react";
import { useMediaQuery } from "@mmo/ui/hooks";
import { engine } from "./bridge/engine";
import { subscribeMixerState, subscribeHidInput } from "./bridge/events";
import { windowCtl } from "./bridge/window";
import { useMixerStore } from "./state/mixer-store";
import { useUiStore } from "./state/ui-store";
import { useCompanionStore } from "./state/companion-store";
import { useAutoMixStore } from "./state/auto-mix-store";
import { useShortcuts } from "./lib/use-shortcuts";
import { useHidStore } from "./state/hid-store";
import { pushHidFeedback } from "./lib/hid-feedback";
import { startCloudAutoSync } from "./lib/cloud-sync";
import { useSettingsHotkey } from "./settings/hotkey";
import { TitleBar } from "./shell/TitleBar";
import { Workspace, useEffectiveLayout } from "./shell/Workspace";
import { StatusRegion } from "./shell/StatusRegion";
import { StatusBar } from "./shell/StatusBar";
import { useShellHotkeys } from "./shell/shell-hotkeys";
import { useBeatAccent } from "./shell/beat-accent";
import { useAllLayouts, useLayoutStore } from "./layout/layout-store";
import { minimumSize } from "./layout/solver";
import { DEFAULT_LAYOUT, PANEL_SPECS } from "./layout/presets";
import { usePackSync } from "./packs/pack-store";
import { TryBanner } from "./packs/TryBanner";
import { useLookNumber } from "./look/look";
import { startWaveSync } from "./state/wave-store";
import { startPlayHistory } from "./state/history-store";

// Overlays and secondary surfaces load on demand so the entry chunk stays small.
const SettingsPanel = lazy(() => import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const ShortcutsOverlay = lazy(() => import("./components/ShortcutsOverlay").then((m) => ({ default: m.ShortcutsOverlay })));
const CommandPalette = lazy(() => import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const LayoutEditor = lazy(() => import("./layout/LayoutEditor").then((m) => ({ default: m.LayoutEditor })));
const Onboarding = lazy(() => import("./shell/Onboarding").then((m) => ({ default: m.Onboarding })));
const SkinEditorHost = lazy(() => import("./settings/SkinEditor").then((m) => ({ default: m.SkinEditorHost })));
const PluginServices = lazy(() =>
    import("./plugins/host").then((m) => ({
        default: function PluginServices() {
            return (
                <>
                    <m.PluginToasts />
                    <m.PluginHotkeys />
                    <m.PluginAutomation />
                </>
            );
        },
    })),
);

/** 4 decks need ≥ 1600 px (100 rem) — see docs/mixai-design-tracker WP3-04. */
export const FOUR_DECK_QUERY = "(min-width: 100rem)";

export function App() {
    const hydrate = useMixerStore((s) => s.hydrate);
    const setHydrated = useMixerStore((s) => s.setHydrated);
    const setNative = useMixerStore((s) => s.setNative);
    const syncCompanion = useCompanionStore((s) => s.sync);
    const deckCountPref = useUiStore((s) => s.deckCount);
    const canFourDeck = useMediaQuery(FOUR_DECK_QUERY);
    const layoutActive = useLayoutStore((s) => s.activeId);
    const allLayouts = useAllLayouts();
    const activeLayout = useEffectiveLayout(allLayouts.find((l) => l.id === layoutActive) ?? DEFAULT_LAYOUT);
    const titlebarH = useLookNumber("--titlebar-h", 40);
    const shellPad = useLookNumber("--shell-pad", 8);
    const statusH = useLookNumber("--statusbar-h", 22);

    useShortcuts();
    useSettingsHotkey();
    useShellHotkeys();
    useBeatAccent();
    usePackSync();

    // Legacy 2/4-deck preference: picking 4 decks on a wide window selects the 4-deck layout.
    // Only when the preference CHANGES: a persisted "4 decks" must not move the default layout
    // (or the one a skin selected) to four-deck at every launch or window resize.
    const deckCountSeen = useRef(deckCountPref);
    useEffect(() => {
        if (deckCountSeen.current === deckCountPref) return;
        deckCountSeen.current = deckCountPref;
        const ls = useLayoutStore.getState();
        const twoDeck = ls.activeId === "classic" || ls.activeId === DEFAULT_LAYOUT.id;
        if (deckCountPref === 4 && canFourDeck && twoDeck) ls.setActive("four-deck");
        if (deckCountPref === 2 && ls.activeId === "four-deck") ls.setActive(DEFAULT_LAYOUT.id);
    }, [deckCountPref, canFourDeck]);

    // Native minimum window size follows the active layout (essential panels never dock).
    useEffect(() => {
        const m = minimumSize(activeLayout, PANEL_SPECS);
        // + title bar + status bar + shell padding (left/right, bottom).
        void windowCtl.setMinSize(Math.max(960, m.w + 2 * shellPad), Math.max(600, m.h + titlebarH + statusH + shellPad));
    }, [activeLayout, titlebarH, statusH, shellPad]);

    // Three-band waveforms follow the loaded tracks.
    useEffect(() => startWaveSync(), []);
    // Play history (library: played rows, "not played tonight").
    useEffect(() => startPlayHistory(), []);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        void (async () => {
            try {
                const native = await engine.isNative();
                if (cancelled) return;
                setNative(native);
                syncCompanion();
                const snapshot = await engine.getState();
                if (cancelled) return;
                if (snapshot) hydrate(snapshot);
                else setHydrated();
                const off = await subscribeMixerState((s) => {
                    hydrate(s);
                    useAutoMixStore.getState().tick();
                    pushHidFeedback(useHidStore.getState().preset, s);
                });
                // Cleanup ran while we were subscribing (StrictMode mounts twice): drop it now.
                if (cancelled) off();
                else unlisten = off;
            } catch (e) {
                // No snapshot will come: show the (empty) decks instead of skeletons for ever.
                console.error("[mixai] engine start failed", e);
                if (!cancelled) setHydrated();
            }
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [hydrate, setHydrated, setNative, syncCompanion]);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        void subscribeHidInput((e) => useHidStore.getState().onReport(e))
            .then((u) => {
                if (cancelled) u();
                else unlisten = u;
            })
            .catch((e) => console.error("[mixai] HID input subscription failed", e));
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => startCloudAutoSync(), []);

    return (
        <div className="mixai-shell">
            <TitleBar />
            <Workspace />
            <StatusBar />
            <StatusRegion />
            <TryBanner />
            <Suspense fallback={null}>
                <SettingsPanel />
                <ShortcutsOverlay />
                <CommandPalette />
                <LayoutEditor />
                <Onboarding />
                <SkinEditorHost />
                <PluginServices />
            </Suspense>
        </div>
    );
}
