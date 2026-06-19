import { useEffect } from "react";
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
import { useShortcuts } from "./lib/use-shortcuts";
import { PluginDock, PluginToasts, PluginHotkeys, PluginAutomation } from "./plugins/host";
import { useHidStore } from "./state/hid-store";
import { pushHidFeedback } from "./lib/hid-feedback";
import { startCloudAutoSync } from "./lib/cloud-sync";

export function App() {
    const hydrate = useMixerStore((s) => s.hydrate);
    const setNative = useMixerStore((s) => s.setNative);
    const deckCount = useUiStore((s) => s.deckCount);
    const settingsOpen = useUiStore((s) => s.settingsOpen);
    const syncCompanion = useCompanionStore((s) => s.sync);

    useShortcuts();

    useEffect(() => {
        let unlisten: (() => void) | undefined;
        (async () => {
            setNative(await engine.isNative());
            // Push persisted companion credentials to the native HTTP proxy.
            syncCompanion();
            const snapshot = await engine.getState();
            if (snapshot) hydrate(snapshot);
            unlisten = await subscribeMixerState((s) => {
                hydrate(s);
                // Advance the auto-mix state machine on every transport tick.
                useAutoMixStore.getState().tick();
                // Reflect transport state back to controller LEDs (diffed write).
                pushHidFeedback(useHidStore.getState().preset, s);
            });
        })();
        return () => unlisten?.();
    }, [hydrate, setNative, syncCompanion]);

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

    return (
        <div
            style={{
                height: "100%",
                display: "grid",
                // Top bar (auto) + main deck/mixer area + bottom library/utility
                // band. Both flexible rows get `minmax(0, …)` so they can shrink
                // and scroll *internally* instead of overflowing the window.
                gridTemplateRows: "auto minmax(0, 2.1fr) minmax(0, 1fr)",
                gap: 12,
                padding: 12,
                overflow: "hidden",
            }}
        >
            <TopBar />

            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto 1fr",
                    gap: 12,
                    minHeight: 0,
                }}
            >
                <div
                    style={{
                        display: "grid",
                        gap: 12,
                        gridAutoRows: "max-content",
                        minHeight: 0,
                        overflowY: "auto",
                    }}
                >
                    {leftDecks.map((id) => (
                        <Deck key={id} deckId={id} />
                    ))}
                </div>

                {/* Mixer + crossfader live together in the center column — the
                    crossfader belongs directly under the channel faders. */}
                <div style={{ display: "grid", gridTemplateRows: "1fr auto", gap: 12, minHeight: 0 }}>
                    <MixerStrip decks={deckCount === 4 ? ["c", "a", "b", "d"] : ["a", "b"]} />
                    <Crossfader />
                </div>

                <div
                    style={{
                        display: "grid",
                        gap: 12,
                        gridAutoRows: "max-content",
                        minHeight: 0,
                        overflowY: "auto",
                    }}
                >
                    {rightDecks.map((id) => (
                        <Deck key={id} deckId={id} />
                    ))}
                </div>
            </div>

            {/* Bottom band: a single horizontal row so it stays short. Library
                flexes; the utility panels are fixed-width and scroll internally.
                Everything has `minHeight: 0` so it clips to the band height. */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 260px 300px auto",
                    gap: 12,
                    minHeight: 0,
                }}
            >
                <Library />
                <div className="panel" style={{ padding: 12, minHeight: 0, overflowY: "auto" }}>
                    <AutoMixPanel />
                </div>
                <div className="panel" style={{ padding: 12, minHeight: 0, overflowY: "auto" }}>
                    <SamplerPanel accent="var(--accent-deck-a)" />
                </div>
                {/* Plugin dock: `auto` column collapses to 0 when no plugin
                    panels are active, so it doesn't reserve dead space. */}
                <div style={{ minHeight: 0, overflowY: "auto", display: "grid", gridAutoFlow: "column", gap: 12 }}>
                    <PluginDock accent="var(--accent)" />
                </div>
            </div>

            {settingsOpen && <SettingsPanel />}
            <ShortcutsOverlay />
            <PluginToasts />
            <PluginHotkeys />
            <PluginAutomation />
        </div>
    );
}
