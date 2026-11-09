/**
 * Zero-scroll workspace: measures itself, runs the layout solver, and places
 * every panel absolutely in its rect with the tier it got. Panels that do not
 * fit go into the dock (tabs that share the host panel's slot). Layout changes
 * (preset switch, snapshot, stage mode, resize across a tier boundary) morph
 * with Motion; under reduced motion / governor they snap.
 */
import { Suspense, lazy, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LayoutGroup, motion } from "motion/react";
import { ExternalLink } from "lucide-react";
import { Skeleton, SkeletonText } from "@mmo/ui";
import { Deck } from "@/components/Deck";
import { MixerStrip } from "@/components/MixerStrip";
import { Crossfader } from "@/components/Crossfader";
import { MasterClock } from "@/components/MasterClock";
import { useMixerStore } from "@/state/mixer-store";
import { useUiStore } from "@/state/ui-store";
import { solve } from "@/layout/solver";
import { PANEL_SPECS, STAGE } from "@/layout/presets";
import { useAllLayouts, useLayoutStore } from "@/layout/layout-store";
import { PanelTierProvider } from "@/layout/panel-tier";
import type { LayoutDoc, PanelId, Placement, Rect } from "@/layout/types";
import { windowCtl, platform } from "@/bridge/window";
import { useMotionOK } from "./motion";
import { useT } from "@/i18n";

const Library = lazy(() => import("@/components/Library").then((m) => ({ default: m.Library })));
const SamplerPanel = lazy(() => import("@/components/SamplerPanel").then((m) => ({ default: m.SamplerPanel })));
const AutoMixPanel = lazy(() => import("@/components/AutoMixPanel").then((m) => ({ default: m.AutoMixPanel })));
const PluginDock = lazy(() => import("@/plugins/host").then((m) => ({ default: m.PluginDock })));

const DECK_OF: Partial<Record<PanelId, "a" | "b" | "c" | "d">> = { deckA: "a", deckB: "b", deckC: "c", deckD: "d" };

/** Panels whose deck is not part of the layout's mixer get filtered from the channel list. */
function mixerDecks(layout: LayoutDoc): ("a" | "b" | "c" | "d")[] {
    const has = new Set(layout.areas.map((a) => a.panel));
    const order: ["deckC", "deckA", "deckB", "deckD"] = ["deckC", "deckA", "deckB", "deckD"];
    return order.filter((p) => has.has(p)).map((p) => DECK_OF[p]!);
}

export function renderPanel(id: PanelId, layout: LayoutDoc, hydrated: boolean): ReactNode {
    const deck = DECK_OF[id];
    if (deck) return hydrated ? <Deck deckId={deck} /> : <DeckSkeleton />;
    switch (id) {
        case "clock":
            return <MasterClock deckCount={mixerDecks(layout).length > 2 ? 4 : 2} />;
        case "mixer":
            return <MixerStrip decks={mixerDecks(layout)} />;
        case "crossfader":
            return <Crossfader />;
        case "library":
            return (
                <Suspense fallback={<PanelSkeleton />}>
                    <Library />
                </Suspense>
            );
        case "automix":
            return (
                <Suspense fallback={<PanelSkeleton />}>
                    <AutoMixPanel />
                </Suspense>
            );
        case "sampler":
            return (
                <Suspense fallback={<PanelSkeleton />}>
                    <SamplerPanel accent="var(--accent-deck-a)" />
                </Suspense>
            );
        case "plugins":
            return (
                <Suspense fallback={null}>
                    <PluginDock accent="var(--accent)" />
                </Suspense>
            );
        default:
            return null;
    }
}

function useBoxSize<T extends HTMLElement>() {
    const ref = useRef<T | null>(null);
    const [size, setSize] = useState({ w: 0, h: 0 });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
        read();
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return [ref, size] as const;
}

export function Workspace() {
    const t = useT();
    const hydrated = useMixerStore((s) => s.hydrated);
    const stage = useUiStore((s) => s.stage);
    const activeId = useLayoutStore((s) => s.activeId);
    const all = useAllLayouts();
    const motionOK = useMotionOK();
    const [ref, size] = useBoxSize<HTMLDivElement>();

    const layout = stage ? STAGE : (all.find((l) => l.id === activeId) ?? all[0]!);
    const sol = useMemo(() => (size.w > 0 && size.h > 0 ? solve(layout, size, PANEL_SPECS) : null), [layout, size]);

    // Dock: docked panels become tabs in the host slot (the host itself is the first tab).
    const host = useMemo(() => {
        if (!sol || sol.docked.length === 0 || !sol.dock) return null;
        const d = sol.dock;
        return sol.placements.find((p) => p.rect.x === d.x && p.rect.y === d.y && p.rect.w === d.w && p.rect.h === d.h) ?? null;
    }, [sol]);

    const transition = motionOK ? { type: "spring" as const, stiffness: 420, damping: 38, mass: 0.8 } : { duration: 0 };

    return (
        <div ref={ref} className="mixai-workspace" data-layout={layout.id}>
            {sol && (
                <LayoutGroup id="workspace">
                    {sol.placements.map((p) =>
                        host && p.panel === host.panel ? (
                            <DockSlot key={`dock-${p.panel}`} host={p} docked={sol.docked} layout={layout} hydrated={hydrated} transition={transition} />
                        ) : (
                            <PanelBox key={p.panel} p={p} transition={transition}>
                                {renderPanel(p.panel, layout, hydrated)}
                            </PanelBox>
                        ),
                    )}
                </LayoutGroup>
            )}
            {!sol && <span className="sr-only">{t("app.loading")}</span>}
        </div>
    );
}

function PanelBox({ p, transition, children }: { p: Placement; transition: object; children: ReactNode }) {
    return (
        <motion.div
            layout
            layoutId={`panel-${p.panel}`}
            transition={transition}
            className="mixai-panel-box"
            data-panel={p.panel}
            data-tier={p.tier}
            style={rectStyle(p.rect)}
        >
            <PanelTierProvider tier={p.tier}>{children}</PanelTierProvider>
        </motion.div>
    );
}

function rectStyle(r: Rect) {
    return { left: r.x, top: r.y, width: r.w, height: r.h };
}

const POP_OUT_OK = new Set<PanelId>(["library", "deckA", "deckB", "deckC", "deckD", "mixer", "automix", "sampler"]);

function DockSlot({
    host,
    docked,
    layout,
    hydrated,
    transition,
}: {
    host: Placement;
    docked: PanelId[];
    layout: LayoutDoc;
    hydrated: boolean;
    transition: object;
}) {
    const t = useT();
    const tabs = [host.panel, ...docked];
    const [active, setActive] = useState<PanelId>(host.panel);
    const current = tabs.includes(active) ? active : host.panel;
    const TAB_H = 30;
    const inner: Rect = { x: 0, y: TAB_H + 4, w: host.rect.w, h: Math.max(0, host.rect.h - TAB_H - 4) };
    const spec = PANEL_SPECS[current];
    const tier = spec.min.full.w <= inner.w && spec.min.full.h <= inner.h ? "full" : spec.min.compact.w <= inner.w && spec.min.compact.h <= inner.h ? "compact" : "icon";
    const canPop = platform() !== "browser";

    return (
        <motion.div layout layoutId={`panel-${host.panel}`} transition={transition} className="mixai-panel-box mixai-dock" data-panel="dock" style={rectStyle(host.rect)}>
            <div role="tablist" aria-label={t("shell.dock")} className="mixai-dock-tabs" style={{ height: TAB_H }}>
                {tabs.map((id) => (
                    <button
                        key={id}
                        type="button"
                        role="tab"
                        id={`dock-tab-${id}`}
                        aria-controls="dock-panel"
                        aria-selected={id === current}
                        className="mixai-dock-tab"
                        onClick={() => setActive(id)}
                        onKeyDown={(e) => {
                            const i = tabs.indexOf(current);
                            const map: Record<string, number> = { ArrowRight: (i + 1) % tabs.length, ArrowLeft: (i + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
                            if (!(e.key in map)) return;
                            e.preventDefault();
                            const next = tabs[map[e.key]!]!;
                            setActive(next);
                            (e.currentTarget.parentElement?.children[tabs.indexOf(next)] as HTMLElement | undefined)?.focus();
                        }}
                        tabIndex={id === current ? 0 : -1}
                    >
                        {id === current && <motion.span layoutId="dock-active" className="mixai-dock-tab-bg" transition={transition} />}
                        <span className="relative">{t(`shell.panel.${id}` as const)}</span>
                    </button>
                ))}
                <span className="flex-1" />
                {canPop && POP_OUT_OK.has(current) && (
                    <button type="button" className="mixai-dock-tab" aria-label={t("shell.popOut")} title={t("shell.popOut")} onClick={() => void windowCtl.popOut(current)}>
                        <ExternalLink className="size-3.5" aria-hidden />
                    </button>
                )}
            </div>
            <div role="tabpanel" id="dock-panel" aria-labelledby={`dock-tab-${current}`} className="absolute inset-x-0 bottom-0" style={{ top: inner.y }}>
                <PanelTierProvider tier={tier}>{renderPanel(current, layout, hydrated)}</PanelTierProvider>
            </div>
        </motion.div>
    );
}

export function PanelSkeleton() {
    return (
        <div className="panel grid h-full gap-3 overflow-hidden p-3" aria-busy="true">
            <Skeleton className="h-8 w-full" />
            <SkeletonText lines={3} />
        </div>
    );
}

function DeckSkeleton() {
    return (
        <div className="panel grid h-full content-start gap-3 overflow-hidden p-3" aria-busy="true">
            <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-20 w-full" />
            <div className="flex gap-2">
                <Skeleton className="h-10 flex-1" />
                <Skeleton className="h-10 w-16" />
            </div>
        </div>
    );
}
