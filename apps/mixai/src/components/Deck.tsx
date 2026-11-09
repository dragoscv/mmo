import { Suspense, lazy } from "react";
import { motion } from "motion/react";
import { Layers, Lock, LockOpen, Minus, Pause, Play, Plus, Repeat, SlidersHorizontal, Sparkles, Target } from "lucide-react";
import { Skeleton, Tabs, TabsContent, TabsList, TabsTrigger, cn } from "@mmo/ui";
import { engine } from "@/bridge/engine";
import type { DeckId, DeckState } from "@/bridge/types";
import { useMixerStore } from "@/state/mixer-store";
import { usePanelTier } from "@/layout/panel-tier";
import { useT } from "@/i18n";
import { Waveform } from "./Waveform";
import { HotCuePads, LoopEditRow, LoopRow } from "./PerformancePads";
import { BeatJump, DeckPerformance, KeyControls, MasterBadge, ModeToggles, SyncButton, useDeckKey } from "./DeckPerformance";
import { ColorFx } from "./ColorFx";
import { MorePopover, iconBtn, tierLayout, useMotionOK } from "./panel-ui";
import { useDeckUi, type DeckTab } from "./deck-ui-store";

// Tab bodies not needed for first paint of the transport.
const StemControls = lazy(() => import("./StemControls").then((m) => ({ default: m.StemControls })));
const FxPanel = lazy(() => import("./FxPanel").then((m) => ({ default: m.FxPanel })));

function fmtTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
}

const TEMPO_MIN = 0.5;
const TEMPO_MAX = 1.5;
const fmtTempo = (tempo: number) => {
    const pct = (tempo - 1) * 100;
    return (pct >= 0 ? "+" : "") + pct.toFixed(1) + "%";
};

interface DeckCtx {
    deckId: DeckId;
    deck: DeckState;
    accent: string;
    id: string;
    keyInfo: ReturnType<typeof useDeckKey>;
    togglePlay: () => void;
    cue: (e: React.MouseEvent) => void;
    setTempo: (t: number) => void;
    toggleKeyLock: () => void;
}

/**
 * One deck, rendered for the tier the layout solver gave it (full / compact /
 * icon). The root always fills its box and never scrolls: the waveform and the
 * tab body take the flexible rows, every other row is fixed height. Controls a
 * smaller tier hides stay reachable through popovers.
 */
export function Deck({ deckId }: { deckId: DeckId }) {
    const t = useT();
    const tier = usePanelTier();
    const motionOK = useMotionOK();
    const deck = useMixerStore((s) => s.deck(deckId));
    const patchDeck = useMixerStore((s) => s.patchDeck);
    const cuePoint = useDeckUi((s) => s.cuePoint[deckId]);
    const setCuePoint = useDeckUi((s) => s.setCuePoint);
    const keyInfo = useDeckKey(deckId);

    // Deck colours are fixed per deck (D9) and never follow the theme accent.
    const accent = `var(--deck-${deckId})`;

    const togglePlay = () => {
        const next = !deck.playing;
        patchDeck(deckId, { playing: next });
        if (next) void engine.play(deckId);
        else void engine.pause(deckId);
    };

    // CDJ-style CUE: while playing → stop and return to the cue point; while
    // paused → store the current position as the cue point (Shift: return).
    const cue = (e: React.MouseEvent) => {
        if (!deck.loaded) return;
        if (deck.playing || e.shiftKey) {
            if (deck.playing) {
                patchDeck(deckId, { playing: false });
                void engine.pause(deckId);
            }
            patchDeck(deckId, { position: cuePoint });
            void engine.seek(deckId, cuePoint);
        } else {
            setCuePoint(deckId, deck.position);
        }
    };

    const setTempo = (v: number) => {
        const next = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, v));
        patchDeck(deckId, { tempo: next });
        void engine.setTempo(deckId, next);
    };

    const toggleKeyLock = () => {
        const next = !deck.keyLock;
        patchDeck(deckId, { keyLock: next });
        void engine.setKeyLock(deckId, next);
    };

    const ctx: DeckCtx = { deckId, deck, accent, id: deckId.toUpperCase(), keyInfo, togglePlay, cue, setTempo, toggleKeyLock };
    const lay = tierLayout(motionOK, tier, `deck-${deckId}`);

    return (
        <section
            aria-label={t("deck.title", { id: ctx.id })}
            className={cn("panel deck-card deck-tier h-full w-full min-h-0 min-w-0 overflow-hidden", tier === "full" ? "p-3" : "p-2")}
            data-playing={deck.playing ? "true" : "false"}
            data-tier={tier}
            style={{ ["--deck" as string]: accent }}
        >
            {tier === "full" && <DeckFull ctx={ctx} lay={lay} />}
            {tier === "compact" && <DeckCompact ctx={ctx} lay={lay} />}
            {tier === "icon" && <DeckIcon ctx={ctx} lay={lay} />}
        </section>
    );
}

type Lay = ReturnType<typeof tierLayout>;

/* ── shared pieces ─────────────────────────────────────────────────────── */

function DeckDot({ accent }: { accent: string }) {
    return <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: accent, boxShadow: `var(--glow) ${accent}` }} />;
}

function bpmText(deck: DeckState) {
    return deck.bpm > 0 ? (deck.bpm * deck.tempo).toFixed(1) : "--";
}

function PlayButton({ ctx, className, iconSize = 14, showLabel = true }: { ctx: DeckCtx; className?: string; iconSize?: number; showLabel?: boolean }) {
    const t = useT();
    const { deck, accent } = ctx;
    return (
        <button
            type="button"
            onClick={ctx.togglePlay}
            disabled={!deck.loaded}
            aria-label={t(deck.playing ? "deck.pauseAria" : "deck.playAria", { id: ctx.id })}
            className={cn(
                "inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5 rounded-lg font-bold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)] disabled:opacity-40",
                className,
            )}
            style={{ background: deck.playing ? accent : "var(--bg-elev-2)", color: deck.playing ? "var(--background)" : "var(--fg)" }}
        >
            {deck.playing ? <Pause size={iconSize} aria-hidden /> : <Play size={iconSize} aria-hidden />}
            {showLabel && <span className="text-[12px]">{deck.playing ? t("deck.pause") : t("deck.play")}</span>}
        </button>
    );
}

function CueButton({ ctx, className }: { ctx: DeckCtx; className?: string }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={ctx.cue}
            disabled={!ctx.deck.loaded}
            aria-label={t("deckui.cueAria", { id: ctx.id })}
            title={t("deckui.cueHint")}
            className={cn(
                "inline-flex min-h-6 min-w-11 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)] px-2 text-[12px] font-bold text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)] disabled:opacity-40",
                className,
            )}
        >
            {t("deckui.cue")}
        </button>
    );
}

function KeyLockButton({ ctx }: { ctx: DeckCtx }) {
    const t = useT();
    const on = ctx.deck.keyLock;
    return (
        <button
            type="button"
            onClick={ctx.toggleKeyLock}
            aria-pressed={on}
            aria-label={t("deck.keyLockAria", { id: ctx.id })}
            title={t("deck.keyLockHint")}
            className="inline-flex min-h-6 min-w-6 shrink-0 items-center gap-1 rounded-lg px-2 text-[10px] font-bold focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
            style={{ background: on ? "var(--accent)" : "var(--bg-elev-2)", color: on ? "var(--accent-fg)" : "var(--fg)" }}
        >
            {on ? <Lock size={12} aria-hidden /> : <LockOpen size={12} aria-hidden />}
            {t("deck.key")}
        </button>
    );
}

function TempoSlider({ ctx }: { ctx: DeckCtx }) {
    const t = useT();
    return (
        <label className="flex min-h-6 min-w-0 items-center gap-2">
            <span className="shrink-0 text-[10px] uppercase text-[var(--fg-dim)]">{t("deck.tempo")}</span>
            <input
                type="range"
                min={TEMPO_MIN}
                max={TEMPO_MAX}
                step={0.001}
                value={ctx.deck.tempo}
                aria-label={t("deck.tempoAria", { id: ctx.id })}
                aria-valuetext={fmtTempo(ctx.deck.tempo)}
                onChange={(e) => ctx.setTempo(Number(e.target.value))}
                onDoubleClick={() => ctx.setTempo(1)}
                className="min-w-0 flex-1"
                style={{ accentColor: ctx.accent }}
            />
            <span className="mono w-14 shrink-0 text-right text-[11px]">{fmtTempo(ctx.deck.tempo)}</span>
        </label>
    );
}

/** −  +1.2%  +  : tempo as a small numeric control (compact tier). Activating the value resets to 0 %. */
function TempoStepper({ ctx }: { ctx: DeckCtx }) {
    const t = useT();
    const { tempo } = ctx.deck;
    return (
        <div role="group" aria-label={t("deck.tempoAria", { id: ctx.id })} className="flex shrink-0 items-center gap-0.5">
            <button type="button" className={iconBtn} aria-label={t("deckui.tempoDown")} onClick={() => ctx.setTempo(tempo - 0.001)} disabled={tempo <= TEMPO_MIN}>
                <Minus size={12} aria-hidden />
            </button>
            <button
                type="button"
                className="mono min-h-6 min-w-12 rounded-md px-1 text-[10px] font-bold focus-visible:outline-2 focus-visible:outline-[var(--ring)]"
                aria-label={t("deckui.tempoReset", { value: fmtTempo(tempo) })}
                title={t("deckui.tempoResetHint")}
                onClick={() => ctx.setTempo(1)}
            >
                {fmtTempo(tempo)}
            </button>
            <button type="button" className={iconBtn} aria-label={t("deckui.tempoUp")} onClick={() => ctx.setTempo(tempo + 0.001)} disabled={tempo >= TEMPO_MAX}>
                <Plus size={12} aria-hidden />
            </button>
        </div>
    );
}

function TabBody({ ctx, tab, compact }: { ctx: DeckCtx; tab: DeckTab; compact?: boolean }) {
    const { deckId, deck, accent } = ctx;
    if (tab === "cues")
        return (
            <div className="grid h-full min-h-0 gap-1.5" style={{ gridTemplateRows: compact ? "minmax(24px, 1fr) 24px" : "minmax(0, 1fr)" }}>
                <HotCuePads deckId={deckId} deck={deck} accent={accent} count={compact ? 4 : 8} className="h-full" />
                {compact && <LoopRow deckId={deckId} deck={deck} />}
            </div>
        );
    if (tab === "loops")
        return (
            <div className="grid h-full min-h-0 gap-1.5" style={{ gridTemplateRows: "minmax(24px, 1fr) minmax(24px, 1fr)" }}>
                <LoopRow deckId={deckId} deck={deck} />
                <LoopEditRow deckId={deckId} deck={deck} />
            </div>
        );
    if (tab === "fx")
        return (
            <Suspense fallback={<Skeleton className="h-full w-full" />}>
                <div className="grid h-full min-h-0 content-start gap-2">
                    <FxPanel deckId={deckId} deck={deck} accent={accent} />
                    <ColorFx deckId={deckId} accent={accent} compact />
                </div>
            </Suspense>
        );
    return (
        <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <StemControls deckId={deckId} deck={deck} accent={accent} className="h-full" />
        </Suspense>
    );
}

const TABS: readonly { tab: DeckTab; label: "deckui.tabCues" | "deckui.tabLoops" | "deckui.tabFx" | "deckui.tabStems"; Icon: typeof Target }[] = [
    { tab: "cues", label: "deckui.tabCues", Icon: Target },
    { tab: "loops", label: "deckui.tabLoops", Icon: Repeat },
    { tab: "fx", label: "deckui.tabFx", Icon: Sparkles },
    { tab: "stems", label: "deckui.tabStems", Icon: Layers },
];

/** Tabbed lower area: only one of hot cues / loops / FX / stems is visible at a time. */
function DeckTabs({ ctx, className }: { ctx: DeckCtx; className?: string }) {
    const t = useT();
    const tab = useDeckUi((s) => s.tab[ctx.deckId]);
    const setTab = useDeckUi((s) => s.setTab);
    return (
        <Tabs
            value={tab}
            onValueChange={(v) => setTab(ctx.deckId, v as DeckTab)}
            className={cn("grid min-h-0 gap-1.5", className)}
            style={{ gridTemplateRows: "24px minmax(0, 1fr)" }}
        >
            <TabsList aria-label={t("deckui.tabsAria", { id: ctx.id })} className="h-6 w-full p-0.5">
                {TABS.map(({ tab: v, label, Icon }) => (
                    <TabsTrigger key={v} value={v} className="min-h-5 gap-1 px-1.5 text-[10px] font-bold uppercase tracking-[0.06em]">
                        <Icon className="size-3" aria-hidden />
                        <span className="truncate">{t(label)}</span>
                    </TabsTrigger>
                ))}
            </TabsList>
            <TabsContent value={tab} className="min-h-0 overflow-hidden">
                <TabBody ctx={ctx} tab={tab} />
            </TabsContent>
        </Tabs>
    );
}

/** Everything a smaller tier hides, in one popover body. */
function DeckMoreBody({ ctx, withTabs }: { ctx: DeckCtx; withTabs?: boolean }) {
    return (
        <div className="grid w-[min(88vw,22rem)] gap-2">
            <DeckPerformance deckId={ctx.deckId} deck={ctx.deck} accent={ctx.accent} keyInfo={ctx.keyInfo} />
            <div className="flex items-center gap-2">
                <KeyLockButton ctx={ctx} />
                <div className="min-w-0 flex-1">
                    <TempoSlider ctx={ctx} />
                </div>
            </div>
            {withTabs && <DeckTabs ctx={ctx} className="h-56" />}
        </div>
    );
}

/* ── tiers ─────────────────────────────────────────────────────────────── */

function DeckFull({ ctx, lay }: { ctx: DeckCtx; lay: Lay }) {
    const t = useT();
    const { deck, deckId, accent, keyInfo } = ctx;
    return (
        <div
            className="grid h-full min-h-0 min-w-0 gap-1.5"
            style={{ gridTemplateRows: "auto minmax(48px, 1fr) auto auto auto minmax(140px, 1.1fr)" }}
        >
            <motion.header {...lay("header")} className="grid min-w-0 gap-0.5">
                <div className="flex min-w-0 items-center gap-2">
                    <DeckDot accent={accent} />
                    <strong className="shrink-0 tracking-[0.1em]">{t("deck.title", { id: ctx.id })}</strong>
                    <span className="min-w-0 flex-1 truncate font-semibold" title={deck.title ?? undefined}>
                        {deck.title ?? t("deck.noTrack")}
                    </span>
                    <span className="mono shrink-0 text-[15px] font-extrabold">
                        {bpmText(deck)}
                        <span className="ml-0.5 text-[9px] font-normal text-[var(--fg-dim)]">BPM</span>
                    </span>
                </div>
                <div className="flex min-w-0 items-center gap-2 text-[11px]">
                    <span className="min-w-0 flex-1 truncate text-[var(--fg-dim)]">{deck.artist ?? "—"}</span>
                    <span
                        className="mono shrink-0 font-bold"
                        role="img"
                        aria-label={keyInfo.playingKey ? t("deck.trackKey", { key: keyInfo.playingKey }) : t("deck.unknownKey")}
                        title={t("deck.trackKeyHint")}
                    >
                        {keyInfo.playingKey ?? "—"}
                    </span>
                    <MasterBadge deckId={deckId} accent={accent} />
                    <span className="mono shrink-0">{fmtTime(deck.position)}</span>
                    <span className="mono shrink-0 text-[var(--fg-dim)]">-{fmtTime(deck.duration - deck.position)}</span>
                </div>
            </motion.header>

            <motion.div {...lay("wave")} className="min-h-0">
                <Waveform deck={deck} accent={accent} />
            </motion.div>

            <motion.div {...lay("transport")} role="group" aria-label={t("deck.perfGroup", { id: ctx.id })} className="flex min-w-0 items-center gap-1">
                <CueButton ctx={ctx} />
                <PlayButton ctx={ctx} className="min-w-16 flex-1 self-stretch" />
                <SyncButton deckId={deckId} deck={deck} accent={accent} />
                <ModeToggles deckId={deckId} deck={deck} accent={accent} />
                <KeyLockButton ctx={ctx} />
            </motion.div>

            <div className="flex min-w-0 items-center justify-between gap-2">
                <BeatJump deckId={deckId} deck={deck} />
                <KeyControls deckId={deckId} deck={deck} keyInfo={keyInfo} showKey={false} />
            </div>

            <TempoSlider ctx={ctx} />

            <motion.div {...lay("lower")} className="min-h-0">
                <DeckTabs ctx={ctx} className="h-full" />
            </motion.div>
        </div>
    );
}

function DeckCompact({ ctx, lay }: { ctx: DeckCtx; lay: Lay }) {
    const t = useT();
    const { deck, deckId, accent } = ctx;
    const tab = useDeckUi((s) => s.tab[deckId]);
    const setTab = useDeckUi((s) => s.setTab);
    const inlineTab: DeckTab = tab === "loops" ? "loops" : "cues";
    return (
        <div className="grid h-full min-h-0 min-w-0 gap-1.5" style={{ gridTemplateRows: "24px minmax(36px, 1fr) 28px minmax(84px, 0.8fr)" }}>
            <motion.header {...lay("header")} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                <DeckDot accent={accent} />
                <strong className="shrink-0 tracking-[0.08em]">{ctx.id}</strong>
                <span className="min-w-0 flex-1 truncate font-semibold" title={[deck.title, deck.artist].filter(Boolean).join(" — ") || undefined}>
                    {deck.title ?? t("deck.noTrack")}
                </span>
                <span className="mono shrink-0 font-bold">{ctx.keyInfo.playingKey ?? "—"}</span>
                <span className="mono shrink-0 font-extrabold">{bpmText(deck)}</span>
                <span className="mono shrink-0 text-[var(--fg-dim)]">-{fmtTime(deck.duration - deck.position)}</span>
            </motion.header>

            <motion.div {...lay("wave")} className="min-h-0">
                <Waveform deck={deck} accent={accent} />
            </motion.div>

            <motion.div {...lay("transport")} className="flex min-w-0 items-stretch gap-1">
                <CueButton ctx={ctx} />
                <PlayButton ctx={ctx} className="min-w-12 flex-1" />
                <SyncButton deckId={deckId} deck={deck} accent={accent} />
                <TempoStepper ctx={ctx} />
                <MorePopover label={t("deckui.moreDeck", { id: ctx.id })} className="self-center">
                    <DeckMoreBody ctx={ctx} />
                </MorePopover>
            </motion.div>

            <motion.div {...lay("lower")} className="grid min-h-0 gap-1.5" style={{ gridTemplateRows: "24px minmax(0, 1fr)" }}>
                <div role="toolbar" aria-label={t("deckui.tabsAria", { id: ctx.id })} className="flex items-center gap-1">
                    {TABS.slice(0, 2).map(({ tab: v, label, Icon }) => (
                        <button
                            key={v}
                            type="button"
                            aria-pressed={inlineTab === v}
                            aria-label={t(label)}
                            title={t(label)}
                            onClick={() => setTab(deckId, v)}
                            className={iconBtn}
                            style={inlineTab === v ? { background: accent, color: "var(--accent-fg)" } : undefined}
                        >
                            <Icon size={13} aria-hidden />
                        </button>
                    ))}
                    <MorePopover label={t("deckui.tabFx")} icon={<Sparkles size={13} aria-hidden />} side="top">
                        <div className="w-[min(88vw,20rem)]">
                            <TabBody ctx={ctx} tab="fx" />
                        </div>
                    </MorePopover>
                    <MorePopover label={t("deckui.tabStems")} icon={<Layers size={13} aria-hidden />} side="top">
                        <div className="h-44 w-[min(88vw,18rem)]">
                            <TabBody ctx={ctx} tab="stems" />
                        </div>
                    </MorePopover>
                    <span className="ml-auto truncate text-[10px] uppercase tracking-[0.1em] text-[var(--fg-dim)]">{t(inlineTab === "loops" ? "deckui.tabLoops" : "deckui.tabCues")}</span>
                </div>
                <div className="min-h-0 overflow-hidden">
                    <TabBody ctx={ctx} tab={inlineTab} compact />
                </div>
            </motion.div>
        </div>
    );
}

function DeckIcon({ ctx, lay }: { ctx: DeckCtx; lay: Lay }) {
    const t = useT();
    const { deck, accent } = ctx;
    const progress = deck.duration > 0 ? Math.min(1, Math.max(0, deck.position / deck.duration)) : 0;
    return (
        <div className="grid h-full min-h-0 min-w-0 gap-1" style={{ gridTemplateRows: "24px auto minmax(28px, 1fr) 4px" }}>
            <motion.header {...lay("header")} className="flex min-w-0 items-center gap-1.5 text-[11px]">
                <DeckDot accent={accent} />
                <strong className="shrink-0">{ctx.id}</strong>
                <span className="min-w-0 flex-1 truncate font-semibold" title={deck.title ?? undefined}>
                    {deck.title ?? t("deck.noTrack")}
                </span>
                <MorePopover label={t("deckui.moreDeck", { id: ctx.id })} icon={<SlidersHorizontal size={13} aria-hidden />}>
                    <DeckMoreBody ctx={ctx} withTabs />
                </MorePopover>
            </motion.header>
            <div className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="mono text-[14px] font-extrabold">
                    {bpmText(deck)}
                    <span className="ml-0.5 text-[9px] font-normal text-[var(--fg-dim)]">BPM</span>
                </span>
                <span className="mono text-[11px] text-[var(--fg-dim)]">-{fmtTime(deck.duration - deck.position)}</span>
            </div>
            <motion.div {...lay("transport")} className="flex min-h-0 gap-1.5">
                <CueButton ctx={ctx} className="h-full min-w-14" />
                <PlayButton ctx={ctx} className="h-full flex-1" iconSize={18} />
            </motion.div>
            <div
                role="progressbar"
                aria-label={t("deckui.progress", { id: ctx.id })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress * 100)}
                className="h-1 overflow-hidden rounded-full bg-[var(--bg-elev-2)]"
            >
                <span className="block h-full origin-left" style={{ background: accent, transform: `scaleX(${progress})` }} />
            </div>
        </div>
    );
}
