import { motion } from "motion/react";
import { Grid2x2, Plus, Repeat, X } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, cn } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import { NUM_PADS, useSamplerStore } from "@/state/sampler-store";
import { usePanelTier } from "@/layout/panel-tier";
import { useT } from "@/i18n";
import { MorePopover, tierLayout, useMotionOK } from "./panel-ui";

/** Filename → display stem (drop directory + extension). */
function stem(path: string): string {
    const base = path.split(/[\\/]/).pop() ?? path;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
}

function useSamplerActions() {
    const pads = useSamplerStore((s) => s.pads);
    const setPad = useSamplerStore((s) => s.setPad);
    return {
        pads,
        load: async (idx: number) => {
            const path = await engine.pickAudioFile();
            if (!path) return;
            await engine.samplerLoad(idx, path);
            setPad(idx, { loaded: true, label: stem(path), path });
            // Push the current gain so the engine matches the UI.
            void engine.samplerSetGain(idx, useSamplerStore.getState().pads[idx]?.gain ?? 0.85);
        },
        trigger: (idx: number) => {
            if (pads[idx]?.loaded) void engine.samplerTrigger(idx);
        },
        clear: (idx: number) => {
            void engine.samplerClear(idx);
            setPad(idx, { loaded: false, label: null, path: null });
        },
        toggleLoop: (idx: number) => {
            const next = !(pads[idx]?.looping ?? false);
            setPad(idx, { looping: next });
            void engine.samplerSetLooping(idx, next);
        },
        setGain: (idx: number, v: number) => {
            setPad(idx, { gain: v });
            void engine.samplerSetGain(idx, v);
        },
    };
}

type Actions = ReturnType<typeof useSamplerActions>;

const mini =
    "inline-flex min-h-6 min-w-6 flex-1 items-center justify-center rounded-md text-[9px] font-bold focus-visible:outline-2 focus-visible:outline-[var(--ring)] disabled:opacity-40";

/** Load / loop / clear + gain for one pad (inline in full tier, in the pad menu otherwise). */
function PadControls({ idx, a, accent, withGain, withClear = true }: { idx: number; a: Actions; accent: string; withGain: boolean; withClear?: boolean }) {
    const t = useT();
    const pad = a.pads[idx];
    const loaded = pad?.loaded ?? false;
    const looping = pad?.looping ?? false;
    const n = idx + 1;
    return (
        <>
            {withGain && (
                <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.01}
                    value={pad?.gain ?? 0.85}
                    aria-label={t("deckui.padGain", { n })}
                    disabled={!loaded}
                    onChange={(e) => a.setGain(idx, Number(e.target.value))}
                    className="min-h-6 w-full min-w-0"
                    style={{ accentColor: accent }}
                />
            )}
            <div className="flex min-w-0 gap-0.5">
                <button type="button" onClick={() => void a.load(idx)} aria-label={t("deckui.padLoad", { n })} title={t("deckui.padLoad", { n })} className={cn(mini, "bg-[var(--bg-elev-2)] text-[var(--fg-dim)]")}>
                    <Plus size={11} aria-hidden />
                </button>
                <button
                    type="button"
                    onClick={() => a.toggleLoop(idx)}
                    disabled={!loaded}
                    aria-pressed={looping}
                    aria-label={t("deckui.padLoop", { n })}
                    title={t("deckui.padLoop", { n })}
                    className={mini}
                    style={{ background: looping ? accent : "var(--bg-elev-2)", color: looping ? "var(--accent-fg)" : "var(--fg-dim)" }}
                >
                    <Repeat size={11} aria-hidden />
                </button>
                {withClear && <button type="button" onClick={() => a.clear(idx)} disabled={!loaded} aria-label={t("deckui.padClear", { n })} title={t("deckui.padClear", { n })} className={cn(mini, "bg-[var(--bg-elev-2)] text-[var(--fg-dim)]")}>
                    <X size={11} aria-hidden />
                </button>}
            </div>
        </>
    );
}

/** The trigger pad. In compact/icon it also opens a context menu (right-click / long-press) with the pad controls. */
function PadButton({ idx, a, accent, menu, className }: { idx: number; a: Actions; accent: string; menu: boolean; className?: string }) {
    const t = useT();
    const pad = a.pads[idx];
    const loaded = pad?.loaded ?? false;
    const n = idx + 1;
    const button = (
        <button
            type="button"
            onClick={() => (loaded ? a.trigger(idx) : void a.load(idx))}
            aria-label={loaded ? t("deckui.padTrigger", { name: pad?.label ?? String(n) }) : t("deckui.padEmpty", { n })}
            title={loaded ? t("deckui.padTrigger", { name: pad?.label ?? String(n) }) : t("deckui.padEmpty", { n })}
            className={cn(
                "flex h-full min-h-6 w-full min-w-6 items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap rounded-lg px-1 text-[11px] font-bold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]",
                className,
            )}
            style={{
                background: loaded ? accent : "var(--bg-elev-2)",
                color: loaded ? "var(--accent-fg)" : "var(--fg-dim)",
                border: `1px ${loaded ? "solid" : "dashed"} ${loaded ? accent : "var(--border)"}`,
                // Looping pads get a visible marker, not colour only.
                boxShadow: pad?.looping ? "inset 0 -3px 0 var(--fg)" : "none",
            }}
        >
            <span className="truncate">{loaded ? pad?.label : t("deckui.padN", { n })}</span>
        </button>
    );
    if (!menu) return button;
    const looping = pad?.looping ?? false;
    return (
        <ContextMenu>
            <ContextMenuTrigger render={button} />
            <ContextMenuContent>
                <ContextMenuItem onClick={() => void a.load(idx)}>
                    <Plus aria-hidden /> {t("deckui.padLoad", { n })}
                </ContextMenuItem>
                <ContextMenuItem disabled={!loaded} onClick={() => a.toggleLoop(idx)}>
                    <Repeat aria-hidden /> {t(looping ? "deckui.padLoopOff" : "deckui.padLoop", { n })}
                </ContextMenuItem>
                <ContextMenuItem disabled={!loaded} onClick={() => a.setGain(idx, Math.min(1.5, (pad?.gain ?? 0.85) + 0.1))}>
                    {t("deckui.padGainUp", { n: Math.round((pad?.gain ?? 0.85) * 100) })}
                </ContextMenuItem>
                <ContextMenuItem disabled={!loaded} onClick={() => a.setGain(idx, Math.max(0, (pad?.gain ?? 0.85) - 0.1))}>
                    {t("deckui.padGainDown", { n: Math.round((pad?.gain ?? 0.85) * 100) })}
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" disabled={!loaded} onClick={() => a.clear(idx)}>
                    <X aria-hidden /> {t("deckui.padClear", { n })}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}

/** Full controls for every pad (popover of the smaller tiers; keyboard-reachable alternative to the context menu). */
function AllPadControls({ a, accent }: { a: Actions; accent: string }) {
    const t = useT();
    return (
        <div className="grid grid-cols-2 gap-2">
            {Array.from({ length: NUM_PADS }, (_, idx) => (
                <div key={idx} className="grid min-w-0 gap-1 rounded-md border border-[var(--border)] p-1.5">
                    <span className="truncate text-[10px] font-bold">{a.pads[idx]?.label ?? t("deckui.padN", { n: idx + 1 })}</span>
                    <PadControls idx={idx} a={a} accent={accent} withGain />
                </div>
            ))}
        </div>
    );
}

/**
 * One-shot sampler: an 8-pad bank. Click a loaded pad to trigger it from the
 * start (re-trigger restarts); an empty pad opens the file picker. Pads mix
 * straight into the master bus.
 *  - full: 8 pads in 2×4, each with gain + load / loop / clear
 *  - compact: 8 pads; per-pad controls in the pad's context menu (right-click /
 *    long-press) and in the "pad settings" popover
 *  - icon: pads 1–4; the rest + controls in a popover
 */
export function SamplerPanel({ accent }: { accent: string }) {
    const t = useT();
    const tier = usePanelTier();
    const lay = tierLayout(useMotionOK(), tier, "sampler");
    const a = useSamplerActions();
    const cols = NUM_PADS / 2;

    const settings = (
        <MorePopover label={t("deckui.padSettings")} title={t("deckui.sampler")} icon={<Grid2x2 size={13} aria-hidden />} contentClassName="w-[min(92vw,22rem)]">
            <AllPadControls a={a} accent={accent} />
        </MorePopover>
    );

    return (
        <section aria-label={t("deckui.sampler")} data-tier={tier} className={cn("panel h-full w-full min-h-0 min-w-0 overflow-hidden", tier === "icon" ? "p-0.5" : "p-2.5")}>
            {tier === "full" && (
                <div className="grid h-full min-h-0 gap-2" style={{ gridTemplateRows: "24px minmax(0, 1fr)" }}>
                    <div className="flex min-w-0 items-center justify-between gap-1">
                        <span className="truncate text-[10px] tracking-[0.12em] text-[var(--fg-dim)]">{t("deckui.sampler")}</span>
                        {settings}
                    </div>
                    <motion.div {...lay("pads")} className="grid min-h-0 gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: "repeat(2, minmax(0, 1fr))" }}>
                        {Array.from({ length: NUM_PADS }, (_, idx) => (
                            <div
                                key={idx}
                                className="grid min-h-0 min-w-0 gap-1 rounded-lg bg-[var(--bg-elev-1)] p-0.5"
                                style={{ gridTemplateRows: "minmax(24px, 1fr) 24px 24px", border: `1px solid ${a.pads[idx]?.loaded ? accent : "var(--border)"}` }}
                            >
                                <PadButton idx={idx} a={a} accent={accent} menu />
                                <PadControls idx={idx} a={a} accent={accent} withGain withClear={false} />
                            </div>
                        ))}
                    </motion.div>
                </div>
            )}
            {tier === "compact" && (
                <div className="grid h-full min-h-0 gap-1.5" style={{ gridTemplateRows: "24px minmax(0, 1fr)" }}>
                    <div className="flex min-w-0 items-center justify-between gap-1">
                        <span className="truncate text-[10px] tracking-[0.12em] text-[var(--fg-dim)]">{t("deckui.sampler")}</span>
                        {settings}
                    </div>
                    <motion.div {...lay("pads")} className="grid min-h-0 gap-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: "repeat(2, minmax(24px, 1fr))" }}>
                        {Array.from({ length: NUM_PADS }, (_, idx) => (
                            <PadButton key={idx} idx={idx} a={a} accent={accent} menu />
                        ))}
                    </motion.div>
                </div>
            )}
            {tier === "icon" && (
                <motion.div {...lay("pads")} className="flex h-full min-h-0 min-w-0 items-stretch gap-1">
                    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-2 gap-0.5" style={{ gridTemplateRows: "repeat(2, minmax(0, 1fr))" }}>
                        {Array.from({ length: 4 }, (_, idx) => (
                            <PadButton key={idx} idx={idx} a={a} accent={accent} menu className="text-[9px]" />
                        ))}
                    </div>
                    <div className="flex items-center">{settings}</div>
                </motion.div>
            )}
        </section>
    );
}
