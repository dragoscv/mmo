import { useEffect } from "react";
import { useIsUltrawide, useMediaQuery } from "@mmo/ui/hooks";
import { Skeleton } from "@mmo/ui";
import { engine } from "./bridge/engine";
import { subscribeMixerState, subscribeHidInput } from "./bridge/events";
import { useMixerStore } from "./state/mixer-store";
import { useUiStore } from "./state/ui-store";
import { useCompanionStore } from "./state/companion-store";
import { TopBar } from "./components/TopBar";
import { Deck } from "./components/Deck";
import { MixerStrip } from "./components/MixerStrip";
import { Crossfader } from "./components/Crossfader";
import { Library } from "./components/Library";
import { SettingsPanel } from "./components/SettingsPanel";
import { SamplerPanel } from "./components/SamplerPanel";
import { AutoMixPanel } from "./components/AutoMixPanel";
import { useAutoMixStore } from "./state/auto-mix-store";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { CommandPalette } from "./components/CommandPalette";
import { useShortcuts } from "./lib/use-shortcuts";
import { PluginDock, PluginToasts, PluginHotkeys, PluginAutomation } from "./plugins/host";
import { useHidStore } from "./state/hid-store";
import { pushHidFeedback } from "./lib/hid-feedback";
import { startCloudAutoSync } from "./lib/cloud-sync";

/** 4 decks need ≥ 1600 px (100 rem) — see docs/mixai-design-tracker WP3-04. */
export const FOUR_DECK_QUERY = "(min-width: 100rem)";

export function App() {
    const hydrate = useMixerStore((s) => s.hydrate);
    const hydrated = useMixerStore((s) => s.hydrated);
    const setHydrated = useMixerStore((s) => s.setHydrated);
    const setNative = useMixerStore((s) => s.setNative);
    const deckCountPref = useUiStore((s) => s.deckCount);
    const settingsOpen = useUiStore((s) => s.settingsOpen);
    const syncCompanion = useCompanionStore((s) => s.sync);
    const canFourDeck = useMediaQuery(FOUR_DECK_QUERY);
    const ultrawide = useIsUltrawide();

    // The 4-deck layout is a preference that only takes effect on wide windows.
    const deckCount: 2 | 4 = deckCountPref === 4 && canFourDeck ? 4 : 2;

    useShortcuts();

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        (async () => {
            const native = await engine.isNative();
            setNative(native);
            // Push persisted companion credentials to the native HTTP proxy.
            syncCompanion();
            const snapshot = await engine.getState();
            if (snapshot) hydrate(snapshot);
            // Browser preview has no engine — stop showing skeletons anyway.
            else setHydrated();
            unlisten = await subscribeMixerState((s) => {
                hydrate(s);
                // Advance the auto-mix state machine on every transport tick.
                useAutoMixStore.getState().tick();
                // Reflect transport state back to controller LEDs (diffed write).
                pushHidFeedback(useHidStore.getState().preset, s);
            });
        })();
        return () => unlisten?.();
    }, [hydrate, setHydrated, setNative, syncCompanion]);

    // Feed raw HID input reports into the mapping store (dispatch + learn).
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        void subscribeHidInput((e) => useHidStore.getState().onReport(e)).then(
            (u) => (unlisten = u),
        );
        return () => unlisten?.();
    }, []);

    // Automatic account sync: pull the cloud profile on launch (when signed
    // in) and debounce-push any local change so the setup follows the user to
    // every device.
    useEffect(() => startCloudAutoSync(), []);

    const leftDecks = deckCount === 4 ? (["c", "a"] as const) : (["a"] as const);
    const rightDecks = deckCount === 4 ? (["b", "d"] as const) : (["b"] as const);

    // Ultra-wide (≥ 21:9): Library + AutoMix move into side columns so the deck
    // band gets the full height; otherwise they share a bottom band.
    const sidePanels = ultrawide;

    return (
        <div
            className="mixai-shell"
            style={{
                gridTemplateRows: sidePanels ? "auto minmax(0, 1fr)" : "auto minmax(0, 2.1fr) minmax(0, 1fr)",
            }}
        >
            <TopBar deckCount={deckCount} canFourDeck={canFourDeck} />

            <div
                className="grid min-h-0 gap-3"
                style={{
                    gridTemplateColumns: sidePanels
                        ? "minmax(18rem, 22rem) 1fr auto 1fr minmax(16rem, 20rem)"
                        : "1fr auto 1fr",
                }}
            >
                {sidePanels && <Library />}

                <div className="grid min-h-0 gap-3 overflow-y-auto" style={{ gridAutoRows: "max-content" }}>
                    {leftDecks.map((id) => (hydrated ? <Deck key={id} deckId={id} /> : <DeckSkeleton key={id} />))}
                </div>

                {/* Mixer + crossfader live together in the center column — the
                    crossfader belongs directly under the channel faders. */}
                <div className="grid min-h-0 gap-3" style={{ gridTemplateRows: "1fr auto" }}>
                    <MixerStrip decks={deckCount === 4 ? ["c", "a", "b", "d"] : ["a", "b"]} />
                    <Crossfader />
                </div>

                <div className="grid min-h-0 gap-3 overflow-y-auto" style={{ gridAutoRows: "max-content" }}>
                    {rightDecks.map((id) => (hydrated ? <Deck key={id} deckId={id} /> : <DeckSkeleton key={id} />))}
                </div>

                {sidePanels && (
                    <div className="grid min-h-0 gap-3" style={{ gridTemplateRows: "auto minmax(0, 1fr) auto" }}>
                        <div className="panel min-h-0 overflow-y-auto p-3">
                            <AutoMixPanel />
                        </div>
                        <div className="panel min-h-0 overflow-y-auto p-3">
                            <SamplerPanel accent="var(--accent-deck-a)" />
                        </div>
                        <div className="grid min-h-0 gap-3 overflow-y-auto">
                            <PluginDock accent="var(--accent)" />
                        </div>
                    </div>
                )}
            </div>

            {/* Bottom band (standard aspect): a single horizontal row so it stays
                short. Library flexes; the utility panels are fixed-width and
                scroll internally. */}
            {!sidePanels && (
                <div
                    className="grid min-h-0 gap-3"
                    style={{ gridTemplateColumns: "minmax(0, 1fr) clamp(14rem, 18vw, 16.25rem) clamp(16rem, 20vw, 18.75rem) auto" }}
                >
                    <Library />
                    <div className="panel min-h-0 overflow-y-auto p-3">
                        <AutoMixPanel />
                    </div>
                    <div className="panel min-h-0 overflow-y-auto p-3">
                        <SamplerPanel accent="var(--accent-deck-a)" />
                    </div>
                    {/* Plugin dock: `auto` column collapses to 0 when no plugin
                        panels are active, so it doesn't reserve dead space. */}
                    <div className="grid min-h-0 gap-3 overflow-y-auto" style={{ gridAutoFlow: "column" }}>
                        <PluginDock accent="var(--accent)" />
                    </div>
                </div>
            )}

            {settingsOpen && <SettingsPanel />}
            <ShortcutsOverlay />
            <CommandPalette />
            <PluginToasts />
            <PluginHotkeys />
            <PluginAutomation />
        </div>
    );
}

/** Placeholder deck while the first engine snapshot is in flight. */
function DeckSkeleton() {
    return (
        <div className="panel grid gap-3 p-3" aria-busy="true">
            <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="h-20 w-full" />
            <div className="flex gap-2">
                <Skeleton className="h-10 flex-1" />
                <Skeleton className="h-10 w-16" />
                <Skeleton className="h-10 w-16" />
            </div>
            <Skeleton className="h-2 w-full" />
        </div>
    );
}
