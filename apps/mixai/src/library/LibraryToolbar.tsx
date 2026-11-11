/**
 * Toolbar pieces of the library: source switch, search field, filter chips, sort buttons and
 * the "Library options" popover that holds whatever a smaller tier cannot show inline (and the
 * ≥ 24 px equivalents of the dense header / row controls).
 */
import type { KeyboardEvent, ReactNode, Ref } from "react";
import { ArrowDown, ArrowUp, Blend, Ellipsis, Heart, ListX, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import type { DeckId } from "@/bridge/types";
import { iconBtn } from "@/components/panel-ui";
import type { MessageKey, Translate } from "@/i18n";
import { DeckDot } from "./LibraryRows";
import { SORT_KEYS, type DeckBrief, type SortKey, type SortState } from "./track-view.ts";

export type Source = "companion" | "local";

export function SourceTabs({ t, source, setSource }: { t: Translate; source: Source; setSource: (s: Source) => void }) {
    return (
        <div role="group" aria-label={t("libraryui.source")} className="lib-tabs">
            {(["companion", "local"] as const).map((s) => (
                <button key={s} type="button" className="dk-tab" aria-pressed={source === s} onClick={() => setSource(s)}>
                    {t(s === "companion" ? "library.companion" : "library.local")}
                </button>
            ))}
        </div>
    );
}

export function SearchField({
    t,
    value,
    onChange,
    onKeyDown,
    inputRef,
}: {
    t: Translate;
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
    inputRef: Ref<HTMLInputElement>;
}) {
    return (
        <label className="lib-search">
            <Search size={12} aria-hidden />
            <input
                ref={inputRef}
                type="search"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t("library.search")}
                aria-label={t("library.search")}
                title={t("libraryui.keysHint")}
                autoComplete="off"
                spellCheck={false}
            />
        </label>
    );
}

export interface Filters {
    /** "Matches deck": compatible key + tempo within the window of that deck. */
    matchDeck: DeckId | null;
    notPlayed: boolean;
    favorites: boolean;
}

export const NO_FILTERS: Filters = { matchDeck: null, notPlayed: false, favorites: false };

export function activeFilterCount(f: Filters): number {
    return (f.matchDeck ? 1 : 0) + (f.notPlayed ? 1 : 0) + (f.favorites ? 1 : 0);
}

/** Filter toggles. `labels` = text chips (wide toolbar, popover); otherwise icon chips with the text as name + tooltip. */
export function FilterChips({
    t,
    decks,
    filters,
    labels,
    onMatch,
    onToggle,
}: {
    t: Translate;
    decks: readonly DeckBrief[];
    filters: Filters;
    labels: boolean;
    onMatch: (deck: DeckId | null) => void;
    onToggle: (key: "notPlayed" | "favorites") => void;
}) {
    // A and B always; C / D once they hold a track.
    const matchDecks = decks.filter((d) => d.id === "a" || d.id === "b" || d.loaded);
    return (
        <div role="group" aria-label={t("libraryui.filters")} className="lib-group">
            {matchDecks.map((d) => {
                const deck = d.id.toUpperCase();
                const on = filters.matchDeck === d.id;
                return (
                    <button
                        key={d.id}
                        type="button"
                        className="dk-btn dk-btn-xs"
                        aria-pressed={on}
                        disabled={!d.loaded && !on}
                        aria-label={t("libraryui.matches", { deck })}
                        title={t(d.loaded ? "libraryui.matchesHint" : "libraryui.matchesNeedsDeck", { deck })}
                        onClick={() => onMatch(on ? null : d.id)}
                    >
                        {labels ? <span>{t("libraryui.matchShort")}</span> : <Blend size={12} aria-hidden />}
                        <DeckDot deck={d.id} />
                    </button>
                );
            })}
            <button
                type="button"
                className="dk-btn dk-btn-xs"
                aria-pressed={filters.notPlayed}
                aria-label={t("libraryui.notPlayed")}
                title={t("libraryui.notPlayedHint")}
                onClick={() => onToggle("notPlayed")}
            >
                <ListX size={12} aria-hidden />
                {labels && <span>{t("libraryui.notPlayed")}</span>}
            </button>
            <button
                type="button"
                className="dk-btn dk-btn-xs"
                aria-pressed={filters.favorites}
                aria-label={t("libraryui.favorites")}
                title={t("libraryui.favoritesHint")}
                onClick={() => onToggle("favorites")}
            >
                <Heart size={12} aria-hidden fill={filters.favorites ? "currentColor" : "none"} />
                {labels && <span>{t("libraryui.favorites")}</span>}
            </button>
        </div>
    );
}

const SORT_LABEL: Record<SortKey, MessageKey> = {
    title: "libraryui.colTitle",
    artist: "libraryui.colArtist",
    bpm: "libraryui.colBpm",
    key: "libraryui.colKey",
    energy: "libraryui.colEnergy",
    duration: "libraryui.colTime",
    genre: "libraryui.colGenre",
    addedAt: "libraryui.colAdded",
    rating: "libraryui.colRating",
    favorite: "libraryui.favorites",
};

/** Every sort the header offers (and the ones it has no column for), as full-size buttons. */
export function SortButtons({
    t,
    sort,
    scoreOrder,
    canScore,
    onSort,
    onScore,
}: {
    t: Translate;
    /** Active column sort; ignored while `scoreOrder` is on. */
    sort: SortState;
    /** "Best match first" (only with a match filter). */
    scoreOrder: boolean;
    canScore: boolean;
    onSort: (key: SortKey) => void;
    onScore: () => void;
}) {
    return (
        <>
            {canScore && (
                <button type="button" className="dk-btn dk-btn-xs" aria-pressed={scoreOrder} onClick={onScore}>
                    {t("libraryui.sortScore")}
                </button>
            )}
            {SORT_KEYS.map((key) => {
                const active = !scoreOrder && sort.key === key;
                const label = t(SORT_LABEL[key]);
                return (
                    <button
                        key={key}
                        type="button"
                        className="dk-btn dk-btn-xs"
                        aria-pressed={active}
                        aria-label={active ? `${label}, ${t(sort.dir === "asc" ? "libraryui.sortAsc" : "libraryui.sortDesc")}` : label}
                        onClick={() => onSort(key)}
                    >
                        {label}
                        {active && (sort.dir === "asc" ? <ArrowUp size={10} aria-hidden /> : <ArrowDown size={10} aria-hidden />)}
                    </button>
                );
            })}
        </>
    );
}

export function PopSection({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div role="group" aria-label={label} className="lib-pop-sec">
            <span className="dk-label">{label}</span>
            <div className="lib-pop-row">{children}</div>
        </div>
    );
}

/** "Library options": a 24×24 button that opens a popover (controlled, so Shift+F10 on the list can open it). */
export function OptionsPopover({
    label,
    open,
    onOpenChange,
    active,
    children,
}: {
    /** Accessible name of the trigger and heading of the popover. */
    label: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Lit when it hides an active filter (the label says so too). */
    active?: boolean;
    children: ReactNode;
}) {
    return (
        <Popover open={open} onOpenChange={(o) => onOpenChange(o)}>
            <PopoverTrigger aria-label={label} title={label} className={iconBtn} data-on={active || undefined}>
                <Ellipsis size={14} aria-hidden />
            </PopoverTrigger>
            <PopoverContent side="top" align="end" className="grid w-auto max-w-[min(92vw,24rem)] gap-3 p-3">
                <PopoverTitle className="dk-label">{label}</PopoverTitle>
                {children}
            </PopoverContent>
        </Popover>
    );
}
