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

    const leftDecks = deckCount === 4 ? (["c", "a"] as const) : (["a"] as const);
    const rightDecks = deckCount === 4 ? (["b", "d"] as const) : (["b"] as const);

    return (
        <div
            style={{
                height: "100%",
                display: "grid",
                gridTemplateRows: "auto 1fr auto",
                gap: 12,
                padding: 12,
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
                <div style={{ display: "grid", gap: 12, gridAutoRows: "1fr" }}>
                    {leftDecks.map((id) => (
                        <Deck key={id} deckId={id} />
                    ))}
                </div>

                <MixerStrip decks={deckCount === 4 ? ["c", "a", "b", "d"] : ["a", "b"]} />

                <div style={{ display: "grid", gap: 12, gridAutoRows: "1fr" }}>
                    {rightDecks.map((id) => (
                        <Deck key={id} deckId={id} />
                    ))}
                </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", gap: 12 }}>
                <Library />
                <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
                    <div className="panel" style={{ padding: 12 }}>
                        <AutoMixPanel />
                    </div>
                    <Crossfader />
                    <div className="panel" style={{ padding: 12 }}>
                        <SamplerPanel accent="var(--accent-deck-a)" />
                    </div>
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
