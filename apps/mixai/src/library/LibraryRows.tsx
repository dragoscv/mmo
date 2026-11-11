/**
 * Library table pieces: the column header (click to sort) and one track row. The header and
 * every row share one `grid-template-columns` (from `track-view.ts`), so columns line up at
 * any width. Rows are memoised: moving the selection re-renders no row content.
 */
import { memo, type MouseEvent, type RefObject } from "react";
import { ArrowDown, ArrowUp, Check, Ellipsis, Heart, Sparkles, Star, TriangleAlert } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@mmo/ui";
import type { DeckId, LibraryTrack } from "@/bridge/types";
import { KeyChip } from "@/components/KeyChip";
import type { TransitionScore } from "@/lib/harmonic";
import type { MessageKey, Translate } from "@/i18n";
import { PreviewWave } from "./PreviewWave";
import { BPM_WINDOW_PCT, bpmDiffPct, energyCells, fmtBpm, fmtDiff, fmtDuration, hasCol, parseAdded, type ColId, type Columns, type SortKey, type SortState } from "./track-view.ts";

export interface StemJobState {
    state: string;
    progress: number;
}

export function trackTitle(tr: LibraryTrack): string {
    return (tr.title ?? "").trim() || tr.filename;
}

/** Deck letter in the deck colour (load buttons). */
export function DeckLetter({ deck }: { deck: DeckId }) {
    return (
        <span aria-hidden className="lib-deckletter" data-deck={deck}>
            {deck.toUpperCase()}
        </span>
    );
}

/** Filled dot in the deck colour with the deck letter inside (never colour only). */
export function DeckDot({ deck }: { deck: DeckId }) {
    return (
        <span aria-hidden className="lib-deckdot" data-deck={deck}>
            {deck.toUpperCase()}
        </span>
    );
}

export interface StemsView {
    kind: "ready" | "running" | "error" | "idle";
    pct: number;
    label: string;
}

/** Stem state of a track: separated already, a job in flight, a failed job, or nothing yet. */
export function stemsView(t: Translate, tr: LibraryTrack, job: StemJobState | undefined): StemsView {
    if (tr.stemsStatus === "ready") return { kind: "ready", pct: 100, label: t("libraryui.stemsReady") };
    if (job && job.state !== "done" && job.state !== "error") {
        const pct = job.state === "running" ? Math.round((job.progress || 0) * 100) : 0;
        return { kind: "running", pct, label: t("libraryui.stemsProgress", { pct }) };
    }
    if (job?.state === "error") return { kind: "error", pct: 0, label: t("libraryui.stemsError") };
    return { kind: "idle", pct: 0, label: t("libraryui.stemsGenerate") };
}

// ─── Header ─────────────────────────────────────────────────────────────────

interface HeadDef {
    label: MessageKey;
    /** Sort key sent to the companion; absent = not sortable. */
    sort?: SortKey;
    end?: boolean;
    /** Label for assistive tech only (the column is self-explanatory visually). */
    hidden?: boolean;
}

const HEAD: Record<ColId, HeadDef> = {
    status: { label: "libraryui.colStatus", hidden: true },
    preview: { label: "libraryui.colPreview" },
    title: { label: "libraryui.colTitle", sort: "title" },
    artist: { label: "libraryui.colArtist", sort: "artist" },
    bpm: { label: "libraryui.colBpm", sort: "bpm", end: true },
    key: { label: "libraryui.colKey", sort: "key" },
    energy: { label: "libraryui.colEnergy", sort: "energy" },
    time: { label: "libraryui.colTime", sort: "duration", end: true },
    genre: { label: "libraryui.colGenre", sort: "genre" },
    added: { label: "libraryui.colAdded", sort: "addedAt" },
    rating: { label: "libraryui.colFav", sort: "favorite" },
    load: { label: "libraryui.colLoad", end: true },
};

/**
 * Column titles. Sortable ones are buttons; the sort state is exposed with `aria-sort` on the
 * column header. `sort` = null while the list is ordered by match score (no arrow).
 */
export function ColumnHeader({ t, cols, sort, onSort }: { t: Translate; cols: Columns; sort: SortState | null; onSort: (key: SortKey) => void }) {
    return (
        <div role="table" aria-label={t("libraryui.columns")}>
            <div role="row" className="lib-head" style={{ gridTemplateColumns: cols.template }}>
                {cols.cols.map((id) => {
                    const def = HEAD[id];
                    const label = t(def.label);
                    const align = def.end ? "end" : undefined;
                    if (!def.sort) {
                        return (
                            <span key={id} role="columnheader" className="lib-thc" data-align={align}>
                                <span className={def.hidden ? "sr-only" : "dk-label lib-th"}>{label}</span>
                            </span>
                        );
                    }
                    const key = def.sort;
                    const dir = sort && sort.key === key ? sort.dir : null;
                    const arrow = dir === "asc" ? <ArrowUp size={10} aria-hidden /> : dir === "desc" ? <ArrowDown size={10} aria-hidden /> : null;
                    return (
                        <span
                            key={id}
                            role="columnheader"
                            aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                            className="lib-thc"
                            data-align={align}
                        >
                            <button
                                type="button"
                                className="dk-label lib-th"
                                data-sorted={dir ?? undefined}
                                title={t("libraryui.sortBy", { column: label })}
                                onClick={() => onSort(key)}
                            >
                                {def.end && arrow}
                                <span>{label}</span>
                                {!def.end && arrow}
                            </button>
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Row ────────────────────────────────────────────────────────────────────

export interface TrackRowProps {
    t: Translate;
    tr: LibraryTrack;
    /** Transition score against the match deck (null without a match filter). */
    match: TransitionScore | null;
    cols: Columns;
    index: number;
    /** Decks that hold this track right now. */
    loadedOn: readonly DeckId[] | undefined;
    /** Played tonight: the row is dimmed and marked. */
    played: boolean;
    /** The last load of this track failed (file not reachable, decode error): warning mark in the status cell. */
    failed?: boolean;
    /** Key the key chip is compared against (match deck, else the playing deck). */
    masterKey: string | null;
    matchDeck: DeckId | null;
    /** Current BPM of the match deck (0 = unknown). */
    refBpm: number;
    stemJob: StemJobState | undefined;
    dateFmt: Intl.DateTimeFormat;
    /** The listbox: focus returns there after a row action or when the row menu closes. */
    listRef: RefObject<HTMLDivElement | null>;
    onSelect: (index: number, focus: boolean) => void;
    onLoad: (deck: DeckId, tr: LibraryTrack) => void;
    onFav: (tr: LibraryTrack) => void;
    onStems: (tr: LibraryTrack) => void;
}

const stop = (e: MouseEvent) => e.stopPropagation();

export const TrackRow = memo(function TrackRow({
    t,
    tr,
    match,
    cols,
    index,
    loadedOn,
    played,
    failed,
    masterKey,
    matchDeck,
    refBpm,
    stemJob,
    dateFmt,
    listRef,
    onSelect,
    onLoad,
    onFav,
    onStems,
}: TrackRowProps) {
    const title = trackTitle(tr);
    const artist = tr.artist?.trim() || t("libraryui.unknownArtist");
    const fav = tr.isFavorite === true;
    // Full tier = separate artist column: the row also gets its menu and the tenths of the BPM.
    const full = hasCol(cols, "artist");
    const act = (fn: () => void) => (e: MouseEvent) => {
        e.stopPropagation();
        fn();
        onSelect(index, true);
    };

    const cell = (id: ColId) => {
        switch (id) {
            case "status":
                return (
                    <span key={id} className="lib-status">
                        {failed && (
                            <span className="lib-status-item lib-status-failed" title={t("libraryui.loadFailedShort")}>
                                <TriangleAlert size={12} aria-hidden />
                                <span className="sr-only">{t("libraryui.loadFailedShort")}</span>
                            </span>
                        )}
                        {loadedOn?.map((deck) => (
                            <span key={deck} className="lib-status-item">
                                <DeckDot deck={deck} />
                                <span className="sr-only">{t("libraryui.onDeck", { deck: deck.toUpperCase() })}</span>
                            </span>
                        ))}
                        {played && (
                            <span className="lib-status-item" title={t("libraryui.played")}>
                                {/* The ✓ needs room: one deck dot at most in the full tier, none in the smaller ones. */}
                                {(loadedOn?.length ?? 0) + (failed ? 1 : 0) <= (full ? 1 : 0) && <Check size={12} aria-hidden />}
                                <span className="sr-only">{t("libraryui.played")}</span>
                            </span>
                        )}
                    </span>
                );
            case "preview":
                return (
                    <span key={id} className="lib-previewcell">
                        <PreviewWave trackId={tr.id} emptyLabel={t("libraryui.noPreview")} />
                    </span>
                );
            case "title":
                return full ? (
                    <span key={id} className="lib-c lib-title" title={title}>
                        {title}
                    </span>
                ) : (
                    // Two boxes that each truncate (the title keeps its room, the artist gives way first):
                    // an inline child of one truncated box would still extend past the panel edge.
                    <span key={id} className="lib-titlecell" title={`${title} · ${artist}`}>
                        <span className="lib-c lib-title">{title}</span>
                        {hasCol(cols, "bpm") && <span className="lib-c lib-dim">{artist}</span>}
                    </span>
                );
            case "artist":
                return (
                    <span key={id} className="lib-c lib-dim" title={artist}>
                        {artist}
                    </span>
                );
            case "bpm": {
                const diff = cols.diff && matchDeck ? bpmDiffPct(tr.bpm, refBpm) : null;
                const deck = matchDeck?.toUpperCase() ?? "";
                return (
                    <span key={id} className="lib-bpm">
                        {diff !== null && (
                            <span
                                className="dk-num lib-diff"
                                data-deck={matchDeck ?? undefined}
                                data-in={Math.abs(diff) <= BPM_WINDOW_PCT + 1e-9}
                                title={
                                    t("libraryui.bpmDiff", { diff: fmtDiff(diff), deck }) +
                                    (match ? ` · ${t("libraryui.score", { pct: Math.round(match.score * 100) })}` : "")
                                }
                            >
                                {fmtDiff(diff)}
                            </span>
                        )}
                        <span className="dk-num lib-num">{full ? fmtBpm(tr.bpm) : tr.bpm && tr.bpm > 0 ? Math.round(tr.bpm) : "–"}</span>
                    </span>
                );
            }
            case "key":
                return (
                    <span key={id} className="lib-keycell">
                        <KeyChip keyName={tr.keyCamelot} against={masterKey} />
                    </span>
                );
            case "energy": {
                const e = tr.energy ?? 0;
                if (e <= 0) return <span key={id} />;
                return (
                    <span key={id} className="lib-energy" role="img" aria-label={t("libraryui.energyOf", { n: e })} title={t("libraryui.energyOf", { n: e })}>
                        <span className="lib-energy-bar" aria-hidden>
                            {energyCells(e).map((f, i) => (
                                <i key={i} data-f={f} />
                            ))}
                        </span>
                        <span className="dk-num lib-num" aria-hidden>
                            {e}
                        </span>
                    </span>
                );
            }
            case "time":
                return (
                    <span key={id} className="dk-num lib-num">
                        {fmtDuration(tr.duration)}
                    </span>
                );
            case "genre":
                return (
                    <span key={id} className="lib-c lib-dim" title={tr.genre ?? undefined}>
                        {tr.genre ?? ""}
                    </span>
                );
            case "added": {
                const d = parseAdded(tr.addedAt);
                return (
                    <span key={id} className="dk-num lib-c lib-dim" title={d ? d.toLocaleString(dateFmt.resolvedOptions().locale) : undefined}>
                        {d ? dateFmt.format(d) : ""}
                    </span>
                );
            }
            case "rating":
                return (
                    <span key={id} className="lib-ratecell">
                        <button
                            type="button"
                            tabIndex={-1}
                            className="lib-fav"
                            aria-pressed={fav}
                            aria-label={t(fav ? "libraryui.favRemove" : "libraryui.favAdd", { title })}
                            title={t(fav ? "libraryui.favRemove" : "libraryui.favAdd", { title })}
                            onClick={act(() => onFav(tr))}
                            onDoubleClick={stop}
                        >
                            <Heart size={12} aria-hidden fill={fav ? "currentColor" : "none"} />
                        </button>
                        {tr.rating ? (
                            <span className="lib-rating" role="img" aria-label={t("libraryui.rating", { n: tr.rating })} title={t("libraryui.rating", { n: tr.rating })}>
                                <Star size={8} aria-hidden fill="currentColor" />
                                <span className="dk-num lib-num" aria-hidden>
                                    {tr.rating}
                                </span>
                            </span>
                        ) : null}
                    </span>
                );
            case "load": {
                const stems = stemsView(t, tr, stemJob);
                const menuLabel = t("libraryui.rowMenu", { title });
                return (
                    <span key={id} className="lib-acts">
                        {(["a", "b"] as const).map((deck) => {
                            const label = t("libraryui.loadTo", { title, deck: deck.toUpperCase() });
                            return (
                                <button
                                    key={deck}
                                    type="button"
                                    tabIndex={-1}
                                    className="dk-btn dk-btn-xs"
                                    aria-label={label}
                                    title={label}
                                    onClick={act(() => onLoad(deck, tr))}
                                    onDoubleClick={stop}
                                >
                                    <DeckLetter deck={deck} />
                                </button>
                            );
                        })}
                        {full && (
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    tabIndex={-1}
                                    className="dk-btn dk-btn-xs"
                                    aria-label={menuLabel}
                                    title={stems.kind === "idle" ? menuLabel : `${menuLabel} · ${stems.label}`}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onSelect(index, false);
                                    }}
                                    onDoubleClick={stop}
                                >
                                    {stems.kind === "running" ? (
                                        <span className="dk-num lib-pct">{stems.pct}%</span>
                                    ) : stems.kind === "ready" ? (
                                        <Sparkles size={12} aria-hidden />
                                    ) : (
                                        <Ellipsis size={14} aria-hidden />
                                    )}
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" side="top" className="w-72" finalFocus={listRef}>
                                    {(["a", "b"] as const).map((deck) => (
                                        <DropdownMenuItem key={deck} onClick={() => onLoad(deck, tr)}>
                                            <DeckDot deck={deck} />
                                            {t("libraryui.loadDeck", { deck: deck.toUpperCase() })}
                                        </DropdownMenuItem>
                                    ))}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => onFav(tr)}>
                                        <Heart aria-hidden fill={fav ? "currentColor" : "none"} />
                                        {t(fav ? "libraryui.favOff" : "libraryui.favOn")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem disabled={stems.kind === "ready" || stems.kind === "running"} onClick={() => onStems(tr)}>
                                        <Sparkles aria-hidden />
                                        <span className="lib-c">{stems.label}</span>
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}
                    </span>
                );
            }
        }
    };

    return (
        <div className="lib-row" data-played={played || undefined} style={{ gridTemplateColumns: cols.template }}>
            {cols.cols.map(cell)}
        </div>
    );
});
