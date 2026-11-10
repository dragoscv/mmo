/**
 * Flexible beatgrid editor (WP19-37): fixed-grid toggle, tempo-marker list with add at the
 * playhead, nudge / retune / delete, all reachable from the keyboard.
 *
 * All maths lives in `src/grid/markers.ts`; this component only renders and dispatches.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Grid3x3, Lock, LockOpen, Plus, Trash2, X } from "lucide-react";
import { cn } from "@mmo/ui";
import type { DeckState } from "@/bridge/types";
import { useT } from "@/i18n";
import { gridActions, useDeckGrid, useDeckGridError, useGridStore } from "@/grid/grid-store";
import { NUDGE_SEC, bpmDraft, commitBpmDraft, isRowEvent, markerRowAction } from "@/grid/editor-keys";
import { BPM_STEP, bpmAt, gridFromDeck } from "@/grid/markers";
import { PanelLabel, iconBtn } from "./panel-ui";

function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Row focus ring, shared by the list rows (WCAG 2.4.7: focus must always be visible). */
const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--ring)]";

/**
 * Text on the `--warning` chip. `--warning` is a light amber in both themes and the design
 * system has no `warning-foreground` role, so the ink is derived from the token itself
 * (same hue, fixed dark lightness) — never a hand-written colour.
 */
const ON_WARNING = "oklch(from var(--warning) 0.18 c h)";

export function GridEditor({ deck, className }: { deck: DeckState; className?: string }) {
    const t = useT();
    const trackId = deck.trackId;
    const stored = useDeckGrid(deck.id, trackId);
    const error = useDeckGridError(deck.id);
    const dismissError = useGridStore((s) => s.dismissError);
    const fallback = gridFromDeck(deck.bpm > 0 ? deck.bpm : 120, deck.firstBeat);
    const grid = stored ?? fallback;
    const playhead = deck.position;

    // Rejections are already handled inside the store (rolled back + `errors[deck]`); the editor
    // only needs to not leave an unhandled rejection behind.
    const act = (p: Promise<unknown>) => void p;

    return (
        <section className={cn("flex min-h-0 flex-col gap-2", className)} aria-label={t("grid.title", { id: deck.id.toUpperCase() })}>
            <header className="flex items-center gap-2">
                <PanelLabel>
                    <Grid3x3 aria-hidden className="mr-1 inline size-3" />
                    {t("grid.title", { id: deck.id.toUpperCase() })}
                </PanelLabel>
                <span className="text-xs tabular-nums text-[var(--fg-muted)]">
                    {t("grid.currentBpm", { bpm: bpmAt(grid, playhead).toFixed(2) })}
                </span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={grid.fixed}
                    className={cn(
                        "ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
                        focusRing,
                        grid.fixed ? "bg-[var(--warning)]" : "bg-[var(--bg-elev-2)] text-[var(--fg)]",
                    )}
                    style={grid.fixed ? { color: ON_WARNING } : undefined}
                    title={t("grid.fixedHint")}
                    onClick={() => act(gridActions.toggleFixed(deck.id, trackId, fallback))}
                >
                    {grid.fixed ? <Lock aria-hidden className="size-3" /> : <LockOpen aria-hidden className="size-3" />}
                    {t("grid.fixed")}
                </button>
                <button
                    type="button"
                    className={iconBtn}
                    aria-label={t("grid.addAria", { time: fmtTime(playhead) })}
                    title={t("grid.addHint")}
                    disabled={!deck.loaded}
                    onClick={() => act(gridActions.addAtPlayhead(deck.id, trackId, fallback, playhead))}
                >
                    <Plus aria-hidden className="size-4" />
                </button>
            </header>

            <p className="text-xs text-[var(--fg-muted)]">{grid.fixed ? t("grid.fixedNote") : t("grid.flexNote")}</p>

            {error ? (
                <p role="alert" className="flex items-start gap-1 rounded-md bg-[var(--bg-elev-2)] px-2 py-1 text-xs text-[var(--danger)]">
                    <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
                    <span className="min-w-0 flex-1">{t("grid.rejected", { detail: error })}</span>
                    <button
                        type="button"
                        className={cn("shrink-0 rounded", focusRing)}
                        aria-label={t("grid.rejectedDismiss")}
                        onClick={() => dismissError(deck.id)}
                    >
                        <X aria-hidden className="size-3" />
                    </button>
                </p>
            ) : null}

            {grid.markers.length === 0 ? (
                <p className="text-xs text-[var(--fg-muted)]">{t("grid.empty")}</p>
            ) : (
                <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto" aria-label={t("grid.listAria")}>
                    {grid.markers.map((m, i) => (
                        <MarkerRow
                            // Stable across a nudge: the marker's position in the list, not its time
                            // (a time-based key remounted the row on every nudge and lost focus).
                            key={`${deck.id}:${trackId ?? ""}:${i}`}
                            deckId={deck.id}
                            trackId={trackId}
                            index={i}
                            bpm={m.bpm}
                            sec={m.sec}
                            fallback={fallback}
                            t={t}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

/** One tempo marker: time, an editable BPM field, nudge buttons and delete. */
function MarkerRow({
    deckId,
    trackId,
    index,
    bpm,
    sec,
    fallback,
    t,
}: {
    deckId: DeckState["id"];
    trackId: string | null;
    index: number;
    bpm: number;
    sec: number;
    fallback: ReturnType<typeof gridFromDeck>;
    t: ReturnType<typeof useT>;
}) {
    const n = String(index + 1);
    // The BPM field is a draft while focused: a controlled value snapped back on every partial
    // entry, so a new tempo could not be typed. Committed on blur or Enter.
    const [draft, setDraft] = useState<string | null>(null);
    useEffect(() => {
        setDraft(null);
    }, [bpm]);

    const commit = () => {
        if (draft === null) return;
        const v = commitBpmDraft(draft);
        setDraft(null);
        if (v !== null && v !== bpm) void gridActions.retune(deckId, trackId, fallback, index, v);
    };

    return (
        <li
            className={cn("flex items-center gap-2 rounded-md bg-[var(--bg-elev-2)] px-2 py-1", focusRing)}
            // Arrow keys nudge the marker, Delete removes it (the row is focusable).
            tabIndex={0}
            onKeyDown={(e) => {
                // Keys typed in the BPM input bubble here too: ignore everything that is not ours.
                if (!isRowEvent(e.target, e.currentTarget)) return;
                const action = markerRowAction(e.key, e.shiftKey);
                if (!action) return;
                e.preventDefault();
                if (action.kind === "nudge") void gridActions.nudge(deckId, trackId, fallback, index, action.deltaSec);
                else if (action.kind === "retune") void gridActions.retune(deckId, trackId, fallback, index, bpm + action.deltaBpm);
                else void gridActions.remove(deckId, trackId, fallback, index);
            }}
            aria-label={t("grid.markerAria", { n, time: fmtTime(sec), bpm: bpm.toFixed(2) })}
        >
            <span className="w-16 text-xs tabular-nums">{fmtTime(sec)}</span>
            <label className="flex items-center gap-1 text-xs">
                <span className="sr-only">{t("grid.markerBpmAria", { n })}</span>
                <input
                    type="number"
                    inputMode="decimal"
                    step={BPM_STEP}
                    min={20}
                    max={400}
                    value={draft ?? bpmDraft(bpm)}
                    className={cn("w-20 rounded bg-[var(--bg-elev)] px-1 py-0.5 tabular-nums", focusRing)}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.preventDefault();
                            commit();
                        } else if (e.key === "Escape") {
                            e.preventDefault();
                            setDraft(null);
                        }
                    }}
                />
                <span aria-hidden>BPM</span>
            </label>
            <button
                type="button"
                className={iconBtn}
                aria-label={t("grid.nudgeBackAria", { n })}
                onClick={() => void gridActions.nudge(deckId, trackId, fallback, index, -NUDGE_SEC)}
            >
                −
            </button>
            <button
                type="button"
                className={iconBtn}
                aria-label={t("grid.nudgeFwdAria", { n })}
                onClick={() => void gridActions.nudge(deckId, trackId, fallback, index, NUDGE_SEC)}
            >
                +
            </button>
            <button
                type="button"
                className={cn(iconBtn, "ml-auto")}
                aria-label={t("grid.removeAria", { n })}
                onClick={() => void gridActions.remove(deckId, trackId, fallback, index)}
            >
                <Trash2 aria-hidden className="size-4" />
            </button>
        </li>
    );
}
