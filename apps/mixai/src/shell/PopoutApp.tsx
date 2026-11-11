/**
 * Second-window view (`index.html?popout=<panel>`, opened by `window_pop_out`).
 * Renders one panel full-window with its own small title bar. State comes from
 * the same engine events (each webview subscribes itself), so decks/mixer stay
 * live; UI-only stores persist through localStorage.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { engine } from "@/bridge/engine";
import { subscribeMixerState } from "@/bridge/events";
import { platform, windowCtl } from "@/bridge/window";
import { useMixerStore } from "@/state/mixer-store";
import { startWaveSync } from "@/state/wave-store";
import { usePackSync } from "@/packs/pack-store";
import { renderPanel } from "./Workspace";
import { DEFAULT_LAYOUT, FOUR_DECK } from "@/layout/presets";
import { PANEL_SPECS } from "@/layout/presets";
import { PanelTierProvider } from "@/layout/panel-tier";
import { PANEL_IDS, type PanelId, type Tier } from "@/layout/types";
import { useT } from "@/i18n";

export function popoutPanel(): PanelId | null {
    const p = new URLSearchParams(location.search).get("popout");
    return p && (PANEL_IDS as readonly string[]).includes(p) ? (p as PanelId) : null;
}

export function PopoutApp({ panel }: { panel: PanelId }) {
    const t = useT();
    const hydrated = useMixerStore((s) => s.hydrated);
    const [tier, setTier] = useState<Tier>("full");
    usePackSync();

    useEffect(() => startWaveSync(), []);

    useEffect(() => {
        let cancelled = false;
        let off: (() => void) | undefined;
        void (async () => {
            const s = useMixerStore.getState();
            s.setNative(await engine.isNative());
            const snap = await engine.getState();
            if (snap) s.hydrate(snap);
            else s.setHydrated();
            const u = await subscribeMixerState((m) => useMixerStore.getState().hydrate(m));
            if (cancelled) u();
            else off = u;
        })();
        return () => {
            cancelled = true;
            off?.();
        };
    }, []);

    useEffect(() => {
        const spec = PANEL_SPECS[panel];
        const read = () => {
            const w = innerWidth;
            const h = innerHeight - 36;
            setTier(w >= spec.min.full.w && h >= spec.min.full.h ? "full" : w >= spec.min.compact.w && h >= spec.min.compact.h ? "compact" : "icon");
        };
        read();
        addEventListener("resize", read);
        return () => removeEventListener("resize", read);
    }, [panel]);

    const layout = panel === "deckC" || panel === "deckD" ? FOUR_DECK : DEFAULT_LAYOUT;
    const native = platform() !== "browser" && platform() !== "macos";

    return (
        <div className="grid h-full grid-rows-[36px_minmax(0,1fr)] overflow-hidden p-2 pt-0">
            <header className="mixai-titlebar" data-tauri-drag-region style={{ height: 36, paddingLeft: platform() === "macos" ? 78 : 8 }}>
                <strong data-tauri-drag-region className="text-gradient-brand font-heading text-sm tracking-[0.18em]">
                    {t("app.name")}
                </strong>
                <span data-tauri-drag-region className="text-xs text-muted-foreground">
                    {t(`shell.panel.${panel}` as const)}
                </span>
                <div data-tauri-drag-region className="flex-1 self-stretch" />
                {native && (
                    <button type="button" className="mixai-winbtn" data-close onClick={() => void windowCtl.close()} aria-label={t("shell.close")}>
                        <X aria-hidden />
                    </button>
                )}
            </header>
            <div className="relative min-h-0 overflow-hidden">
                <PanelTierProvider tier={tier}>
                    <div className="absolute inset-0">{renderPanel(panel, layout, hydrated)}</div>
                </PanelTierProvider>
            </div>
        </div>
    );
}
