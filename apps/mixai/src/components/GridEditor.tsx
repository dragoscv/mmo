/**
 * Beatgrid editor (WP19-37 + the 1.5 look): the whole-grid tools in one or two rows of small
 * buttons (shift, downbeat, halve / double, tap, fixed-grid switch, add a tempo marker, undo)
 * and the tempo-marker list in a popover (nudge / retune / delete, all from the keyboard).
 *
 * Per-marker maths lives in `src/grid/markers.ts`, whole-grid maths in `deck-tabs/grid-ops.ts`;
 * every edit goes through `editGrid`, so each one can be undone.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, List, Lock, LockOpen, Plus, SlidersHorizontal, Trash2, Undo2, X } from "lucide-react";
import { cn } from "@mmo/ui";
import type { DeckState } from "@/bridge/types";
import { useT } from "@/i18n";
import { gridActions, useDeckGrid, useDeckGridError, useGridStore } from "@/grid/grid-store";
import { NUDGE_COARSE_SEC, NUDGE_SEC, bpmDraft, commitBpmDraft, isRowEvent, markerRowAction } from "@/grid/editor-keys";
import { BPM_STEP, bpmAt, gridFromDeck, type GridModel } from "@/grid/markers";
import { usePerfStore } from "@/state/perf-store";
import { MorePopover, iconBtn } from "./panel-ui";
import { deckNow, useDeckValue } from "./deck/use-deck";
import { MARKER_PAGE, addTap, canScaleTempo, downbeatAt, pageCount, retuneAt, scaleTempo, shiftGrid, tapBpm } from "./deck-tabs/grid-ops";
import { editGrid, undoGrid, useCanUndoGrid } from "./deck-tabs/grid-undo";
import { soft } from "./deck-tabs/soft-disabled";
import { useFitLevel } from "./deck-tabs/use-fit";

function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

const ms = (sec: number): string => String(Math.round(sec * 1000));
const xs = "dk-btn dk-btn-xs";

export function GridEditor({ deck, className }: { deck: DeckState; className?: string }) {
    const t = useT();
    const id = deck.id;
    const trackId = deck.trackId;
    const stored = useDeckGrid(id, trackId);
    const error = useDeckGridError(id);
    const dismissError = useGridStore((s) => s.dismissError);
    const canUndo = useCanUndoGrid(id, trackId);
    const taps = useRef<number[]>([]);
    const fallback = gridFromDeck(deck.bpm > 0 ? deck.bpm : 120, deck.firstBeat);
    const grid = stored ?? fallback;
    // The `deck` prop does not follow the position (the editor would render ~30 times a second):
    // handlers read the playhead when they fire, the BPM readout selects its own text.
    const playhead = () => deckNow(id).position;
    const off = !deck.loaded;

    // Rejections are handled inside the store (rolled back + `errors[deck]`); `editGrid` records
    // the grid before the edit for undo. `whole` = an edit of the whole grid, `act` = a store action.
    const act = (tag: string, run: () => Promise<GridModel>) => void editGrid(id, trackId, fallback, tag, run);
    const whole = (tag: string, edit: (g: GridModel) => GridModel) => act(tag, () => useGridStore.getState().edit(id, trackId, fallback, edit));

    const shift = (deltaSec: number) => whole("shift", (g) => shiftGrid(g, deltaSec));
    const tap = () => {
        taps.current = addTap(taps.current, performance.now());
        const bpm = tapBpm(taps.current);
        if (bpm !== null) whole("tap", (g) => retuneAt(g, playhead(), bpm));
    };
    const [bpmInt, bpmFrac] = useDeckValue(id, (d) => bpmAt(grid, d.position).toFixed(2)).split(".");
    const title = t("grid.title", { id: id.toUpperCase() });
    const rejected = error ? t("grid.rejected", { detail: error }) : "";
    // 0 = every tool in the box (one or two rows); 1 = one row: the tools used while beat-matching
    // stay, the rest (fixed-grid switch, coarse shift, halve / double, add a marker) is in a popover.
    const [fitRef, level] = useFitLevel<HTMLDivElement>(1, error ? "error" : "");
    const roomy = level === 0;

    const fixedSwitch = (
        <button
            type="button"
            role="switch"
            aria-checked={grid.fixed}
            data-on={grid.fixed}
            className={xs}
            title={t("grid.fixedHint")}
            onClick={() => act("fixed", () => gridActions.toggleFixed(id, trackId, fallback))}
        >
            {grid.fixed ? <Lock aria-hidden size={11} /> : <LockOpen aria-hidden size={11} />}
            {t("grid.fixed")}
        </button>
    );
    const coarseBack = (
        <button type="button" className={iconBtn} disabled={off} aria-label={t("decktabs.gridShiftBack", { ms: ms(NUDGE_COARSE_SEC) })} title={t("decktabs.gridShiftBack", { ms: ms(NUDGE_COARSE_SEC) })} onClick={() => shift(-NUDGE_COARSE_SEC)}>
            <ChevronsLeft aria-hidden size={13} />
        </button>
    );
    const coarseFwd = (
        <button type="button" className={iconBtn} disabled={off} aria-label={t("decktabs.gridShiftFwd", { ms: ms(NUDGE_COARSE_SEC) })} title={t("decktabs.gridShiftFwd", { ms: ms(NUDGE_COARSE_SEC) })} onClick={() => shift(NUDGE_COARSE_SEC)}>
            <ChevronsRight aria-hidden size={13} />
        </button>
    );
    const halve = (
        <button type="button" className={xs} disabled={off || !canScaleTempo(grid, 0.5)} aria-label={t("decktabs.gridHalve")} title={t("decktabs.gridHalve")} onClick={() => whole("scale", (g) => scaleTempo(g, 0.5))}>
            ÷2
        </button>
    );
    const double = (
        <button type="button" className={xs} disabled={off || !canScaleTempo(grid, 2)} aria-label={t("decktabs.gridDouble")} title={t("decktabs.gridDouble")} onClick={() => whole("scale", (g) => scaleTempo(g, 2))}>
            ×2
        </button>
    );
    const addMarker = (
        <button
            type="button"
            className={iconBtn}
            aria-label={t("grid.addHint")}
            title={t("grid.addHint")}
            disabled={off}
            onClick={() => act("add", () => gridActions.addAtPlayhead(id, trackId, fallback, playhead()))}
        >
            <Plus aria-hidden size={13} />
        </button>
    );

    return (
        <section className={cn("dt-grid", className)} aria-label={title} data-deck-scope="" style={{ ["--deck" as string]: `var(--deck-${id})` }}>
            <div ref={fitRef} className="dt-grid-tools" data-level={level}>
                <span className="dt-grid-bpm" title={t("grid.currentBpm", { bpm: `${bpmInt}.${bpmFrac}` })}>
                    <span className="dk-num dk-num-md">
                        {bpmInt}
                        <span className="dk-num-frac">.{bpmFrac}</span>
                    </span>
                    <span className="dk-label">{t("decktabs.gridBpmUnit")}</span>
                </span>
                {roomy && fixedSwitch}
                <div role="group" aria-label={t("decktabs.gridShift")} className="dt-grid-group">
                    {roomy && coarseBack}
                    <button type="button" className={iconBtn} disabled={off} aria-label={t("decktabs.gridShiftBack", { ms: ms(NUDGE_SEC) })} title={t("decktabs.gridShiftBack", { ms: ms(NUDGE_SEC) })} onClick={() => shift(-NUDGE_SEC)}>
                        <ChevronLeft aria-hidden size={13} />
                    </button>
                    <button type="button" className={iconBtn} disabled={off} aria-label={t("decktabs.gridShiftFwd", { ms: ms(NUDGE_SEC) })} title={t("decktabs.gridShiftFwd", { ms: ms(NUDGE_SEC) })} onClick={() => shift(NUDGE_SEC)}>
                        <ChevronRight aria-hidden size={13} />
                    </button>
                    {roomy && coarseFwd}
                </div>
                <button
                    type="button"
                    className={xs}
                    disabled={off}
                    aria-label={t("decktabs.gridDownbeat")}
                    title={t("decktabs.gridDownbeat")}
                    onClick={() => whole("downbeat", (g) => downbeatAt(g, playhead(), usePerfStore.getState().clock?.beatsPerBar ?? 4))}
                >
                    {t("decktabs.gridDownbeatShort")}
                </button>
                <div role="group" aria-label={t("decktabs.gridTempo")} className="dt-grid-group">
                    {roomy && halve}
                    {roomy && double}
                    <button type="button" className={xs} disabled={off} aria-label={t("decktabs.gridTapAria")} title={t("decktabs.gridTapAria")} onClick={tap}>
                        {t("decktabs.gridTap")}
                    </button>
                </div>
                {roomy ? (
                    addMarker
                ) : (
                    <MorePopover label={t("decktabs.gridMore")} title={title} icon={<SlidersHorizontal size={13} aria-hidden />} side="top">
                        <div className="dt-grid-pop" data-deck-scope="" style={{ ["--deck" as string]: `var(--deck-${id})` }}>
                            {fixedSwitch}
                            <div role="group" aria-label={t("decktabs.gridShift")} className="dt-grid-group">
                                {coarseBack}
                                {coarseFwd}
                            </div>
                            <div role="group" aria-label={t("decktabs.gridTempo")} className="dt-grid-group">
                                {halve}
                                {double}
                            </div>
                            {addMarker}
                        </div>
                    </MorePopover>
                )}
                <MorePopover
                    label={t("decktabs.gridMarkers", { n: grid.markers.length })}
                    title={title}
                    side="top"
                    triggerClassName={xs}
                    triggerContent={
                        <>
                            <List aria-hidden size={12} />
                            <span className="dk-num">{grid.markers.length}</span>
                        </>
                    }
                >
                    <MarkerList deck={deck} grid={grid} fallback={fallback} t={t} />
                </MorePopover>
                <button type="button" className={iconBtn} aria-label={t("decktabs.gridUndo")} title={t("decktabs.gridUndo")} {...soft(!canUndo, () => void undoGrid(id, trackId, fallback))}>
                    <Undo2 aria-hidden size={13} />
                </button>
                {error ? (
                    <p role="alert" className="dt-grid-error" data-compact={roomy ? undefined : ""} title={rejected}>
                        <AlertTriangle aria-hidden size={12} className="dt-grid-error-icon" />
                        <span className={roomy ? "dt-grid-error-text" : "sr-only"}>{rejected}</span>
                        <button type="button" className={iconBtn} aria-label={t("grid.rejectedDismiss")} onClick={() => dismissError(id)}>
                            <X aria-hidden size={12} />
                        </button>
                    </p>
                ) : null}
                <p className="dt-grid-note">{grid.fixed ? t("grid.fixedNote") : t("grid.flexNote")}</p>
            </div>
        </section>
    );
}

/** The tempo markers, six to a page (a list never scrolls), with the grid note above. */
function MarkerList({ deck, grid, fallback, t }: { deck: DeckState; grid: GridModel; fallback: GridModel; t: ReturnType<typeof useT> }) {
    const pages = pageCount(grid.markers.length);
    const [page, setPage] = useState(0);
    const at = Math.min(page, pages - 1);
    const from = at * MARKER_PAGE;
    return (
        <div className="dt-markers" data-deck-scope="" style={{ ["--deck" as string]: `var(--deck-${deck.id})` }}>
            <p className="dt-markers-note">{grid.fixed ? t("grid.fixedNote") : t("grid.flexNote")}</p>
            {grid.markers.length === 0 ? (
                <p className="dt-markers-note">{t("grid.empty")}</p>
            ) : (
                <ul className="dt-marker-list" aria-label={t("grid.listAria")}>
                    {grid.markers.slice(from, from + MARKER_PAGE).map((m, i) => (
                        <MarkerRow
                            // Stable across a nudge: the marker's position in the list, not its time
                            // (a time-based key remounted the row on every nudge and lost focus).
                            key={`${deck.id}:${deck.trackId ?? ""}:${from + i}`}
                            deckId={deck.id}
                            trackId={deck.trackId}
                            index={from + i}
                            bpm={m.bpm}
                            sec={m.sec}
                            fallback={fallback}
                            t={t}
                        />
                    ))}
                </ul>
            )}
            {pages > 1 && (
                <div className="dt-marker-pager">
                    <button type="button" className={iconBtn} aria-label={t("decktabs.gridPagePrev")} {...soft(at === 0, () => setPage(at - 1))}>
                        <ChevronLeft aria-hidden size={13} />
                    </button>
                    <span className="dk-num dk-num-sm" role="status">
                        {t("decktabs.gridPage", { page: at + 1, pages })}
                    </span>
                    <button type="button" className={iconBtn} aria-label={t("decktabs.gridPageNext")} {...soft(at >= pages - 1, () => setPage(at + 1))}>
                        <ChevronRight aria-hidden size={13} />
                    </button>
                </div>
            )}
        </div>
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
    fallback: GridModel;
    t: ReturnType<typeof useT>;
}) {
    const n = String(index + 1);
    // The BPM field is a draft while focused: a controlled value snapped back on every partial
    // entry, so a new tempo could not be typed. Committed on blur or Enter.
    const [draft, setDraft] = useState<string | null>(null);
    useEffect(() => {
        setDraft(null);
    }, [bpm]);

    const act = (tag: string, run: () => Promise<GridModel>) => void editGrid(deckId, trackId, fallback, tag, run);
    const nudge = (deltaSec: number) => act(`nudge:${index}`, () => gridActions.nudge(deckId, trackId, fallback, index, deltaSec));
    const retune = (next: number) => act(`retune:${index}`, () => gridActions.retune(deckId, trackId, fallback, index, next));
    const remove = () => act("remove", () => gridActions.remove(deckId, trackId, fallback, index));

    const commit = () => {
        if (draft === null) return;
        const v = commitBpmDraft(draft);
        setDraft(null);
        if (v !== null && v !== bpm) retune(v);
    };

    return (
        <li
            className="dk-well dt-marker"
            // Arrow keys nudge the marker, Delete removes it (the row is focusable).
            tabIndex={0}
            onKeyDown={(e) => {
                // Keys typed in the BPM input bubble here too: ignore everything that is not ours.
                if (!isRowEvent(e.target, e.currentTarget)) return;
                const action = markerRowAction(e.key, e.shiftKey);
                if (!action) return;
                // The arrows are also global shortcuts (crossfader): here they belong to the row.
                e.preventDefault();
                e.stopPropagation();
                if (action.kind === "nudge") nudge(action.deltaSec);
                else if (action.kind === "retune") retune(bpm + action.deltaBpm);
                else remove();
            }}
            aria-label={t("grid.markerAria", { n, time: fmtTime(sec), bpm: bpm.toFixed(2) })}
        >
            <span className="dk-num dk-num-sm dt-marker-time">{fmtTime(sec)}</span>
            <label className="dt-marker-bpm">
                <span className="sr-only">{t("grid.markerBpmAria", { n })}</span>
                <input
                    type="number"
                    inputMode="decimal"
                    step={BPM_STEP}
                    min={20}
                    max={400}
                    value={draft ?? bpmDraft(bpm)}
                    className="dk-num dt-bpm-input"
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
                <span aria-hidden className="dk-label">
                    {t("decktabs.gridBpmUnit")}
                </span>
            </label>
            <button type="button" className={iconBtn} aria-label={t("grid.nudgeBackAria", { n })} onClick={() => nudge(-NUDGE_SEC)}>
                −
            </button>
            <button type="button" className={iconBtn} aria-label={t("grid.nudgeFwdAria", { n })} onClick={() => nudge(NUDGE_SEC)}>
                +
            </button>
            <button type="button" className={cn(iconBtn, "dt-marker-del")} aria-label={t("grid.removeAria", { n })} onClick={remove}>
                <Trash2 aria-hidden size={13} />
            </button>
        </li>
    );
}
