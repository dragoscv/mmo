import { Suspense, lazy, useEffect } from "react";
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
import { Workspace } from "./shell/Workspace";
import { StatusRegion } from "./shell/StatusRegion";
import { useShellHotkeys } from "./shell/shell-hotkeys";
import { useBeatAccent } from "./shell/beat-accent";
import { useLayoutStore } from "./layout/layout-store";
import { minimumSize } from "./layout/solver";
import { PANEL_SPECS } from "./layout/presets";
import { usePackSync } from "./packs/pack-store";
import { TryBanner } from "./packs/TryBanner";

// Overlays and secondary surfaces load on demand so the entry chunk stays small.
const SettingsPanel = lazy(() => import("./components/SettingsPanel").then((m) => ({ default: m.SettingsPanel })));
const ShortcutsOverlay = lazy(() => import("./components/ShortcutsOverlay").then((m) => ({ default: m.ShortcutsOverlay })));
const CommandPalette = lazy(() => import("./components/CommandPalette").then((m) => ({ default: m.CommandPalette })));
const LayoutEditor = lazy(() => import("./layout/LayoutEditor").then((m) => ({ default: m.LayoutEditor })));
const Onboarding = lazy(() => import("./shell/Onboarding").then((m) => ({ default: m.Onboarding })));
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
    const packLayouts = useLayoutStore((s) => s.packLayouts);

    useShortcuts();
    useSettingsHotkey();
    useShellHotkeys();
    useBeatAccent();
    usePackSync();

    // Legacy 2/4-deck preference: picking 4 decks on a wide window selects the 4-deck layout.
    useEffect(() => {
        const ls = useLayoutStore.getState();
        if (deckCountPref === 4 && canFourDeck && ls.activeId === "classic") ls.setActive("four-deck");
        if (deckCountPref === 2 && ls.activeId === "four-deck") ls.setActive("classic");
    }, [deckCountPref, canFourDeck]);

    // Native minimum window size follows the active layout (essential panels never dock).
    useEffect(() => {
        const l = useLayoutStore.getState().active();
        const m = minimumSize(l, PANEL_SPECS);
        // + title bar (40) + shell padding (2 × 8).
        void windowCtl.setMinSize(Math.max(960, m.w + 16), Math.max(600, m.h + 56));
    }, [layoutActive, packLayouts]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        (async () => {
            const native = await engine.isNative();
            setNative(native);
            syncCompanion();
            const snapshot = await engine.getState();
            if (snapshot) hydrate(snapshot);
            else setHydrated();
            unlisten = await subscribeMixerState((s) => {
                hydrate(s);
                useAutoMixStore.getState().tick();
                pushHidFeedback(useHidStore.getState().preset, s);
            });
        })();
        return () => unlisten?.();
    }, [hydrate, setHydrated, setNative, syncCompanion]);

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        void subscribeHidInput((e) => useHidStore.getState().onReport(e)).then((u) => (unlisten = u));
        return () => unlisten?.();
    }, []);

    useEffect(() => startCloudAutoSync(), []);

    return (
        <div className="mixai-shell">
            <TitleBar />
            <Workspace />
            <StatusRegion />
            <TryBanner />
            <Suspense fallback={null}>
                <SettingsPanel />
                <ShortcutsOverlay />
                <CommandPalette />
                <LayoutEditor />
                <Onboarding />
                <PluginServices />
            </Suspense>
        </div>
    );
}
