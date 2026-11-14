/** MixAI Live main performance screen (fits 1280x720 without scrolling). */
import { Suspense, lazy, useEffect } from "react";
import { LayoutGroup, MotionConfig, useReducedMotion } from "motion/react";
import { useThemePrefs } from "@mmo/ui/theme";
import { Chain } from "./components/Chain";
import { Header } from "./components/Header";
import { InsertDetail } from "./components/InsertDetail";
import { LatencyOverlay } from "./components/LatencyOverlay";
import { LevelMeters } from "./components/Meters";
import { MixStrip } from "./components/MixStrip";
import { Notices } from "./components/Notices";
import { PresetsBar, TapTempo } from "./components/Presets";
import { SetlistPanel } from "./components/Setlist";
import { TunerStrip } from "./components/Tuner";
import { shortcutFor, targetInfo, toggleFor } from "./lib/keyboard";
import { setReducedMotion } from "./lib/meter-bus";
import { useStore } from "./store";

// Dialogs load on first open (keeps the performance screen's initial bundle small).
const SetupWizard = lazy(() => import("./components/SetupWizard").then((m) => ({ default: m.SetupWizard })));
const PairingDialog = lazy(() => import("./components/PairingDialog").then((m) => ({ default: m.PairingDialog })));
const SettingsDialog = lazy(() => import("./components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));

function useShortcuts() {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const s = useStore.getState();
            const action = shortcutFor(e, targetInfo(document.activeElement));
            if (!action) return;
            if (action === "escape") {
                // Dialogs handle Esc themselves; on the main screen it closes the budget peek
                // first, then the detail panel.
                if (!s.panel && s.latencyOverlay) s.toggleLatencyOverlay(false);
                else if (!s.panel && s.selectedInsert != null) s.selectInsert(null);
                return;
            }
            if (s.panel) return;
            e.preventDefault();
            if (action === "bypass" || action === "mute") s.send({ type: "set_mix", ...toggleFor(action, s.proto.state?.mix) });
            else if (action === "prev") s.send({ type: "prev" });
            else if (action === "next") s.send({ type: "next" });
            else if (action === "tap") s.send({ type: "tap_tempo" });
            else if (action === "latency") s.toggleLatencyOverlay();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);
}

export function App() {
    const init = useStore((s) => s.init);
    const loaded = useStore((s) => s.settingsLoaded);
    const panel = useStore((s) => s.panel);
    const latencyOverlay = useStore((s) => s.latencyOverlay);
    const { prefs } = useThemePrefs();
    const osReduced = useReducedMotion();
    const reduced = prefs.motion === "reduced" || !!osReduced;

    useEffect(() => {
        void init();
    }, [init]);
    useEffect(() => setReducedMotion(reduced), [reduced]);
    useShortcuts();

    return (
        <MotionConfig reducedMotion={reduced ? "always" : "never"}>
            <LayoutGroup>
                <div className="grid h-full grid-cols-[minmax(0,1fr)_20rem] grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-3 p-3">
                    {latencyOverlay ? <LatencyOverlay /> : null}
                    <div className="col-span-2">
                        <Header />
                    </div>
                    <div className="col-span-2 flex items-center gap-3">
                        <PresetsBar />
                        <TapTempo />
                    </div>
                    <main className="grid min-h-0 grid-cols-[11rem_minmax(0,1fr)] gap-3">
                        <LevelMeters />
                        <div className="flex min-h-0 flex-col gap-3">
                            <TunerStrip />
                            <Chain />
                            <InsertDetail />
                        </div>
                    </main>
                    <aside className="row-span-2 min-h-0">
                        <SetlistPanel />
                    </aside>
                    <div className="min-w-0">
                        <MixStrip />
                    </div>
                </div>
                <Suspense fallback={null}>
                    {loaded && panel === "setup" ? <SetupWizard /> : null}
                    {panel === "pair" ? <PairingDialog /> : null}
                    {panel === "settings" ? <SettingsDialog /> : null}
                </Suspense>
                <Notices />
            </LayoutGroup>
        </MotionConfig>
    );
}
