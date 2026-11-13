/**
 * Body of the co-pilot popover (opened from CopilotButton in the Library toolbar):
 *   (a) "Ask the co-pilot": a typed RO / EN command (mix next, sync, loop, cancel) or a
 *       set-builder request over the local library ("90s hip-hop 95-105 BPM harmonic");
 *   (b) "Next track": the best matches for the playing deck with their reasons and Load A / B;
 *       a track whose key clashes but fits after a key shift of one or two semitones says so
 *       first in its reasons and gets one more small button: load it on the incoming deck AND
 *       shift its key (Load A / Load B never shift anything). That button is off while the
 *       incoming deck plays (it stays focusable and says why), shows a load in flight, and
 *       does not exist in a pop-out window (a shift applied there would never be undone);
 *   (c) "Mix next": plan a phrase-aligned transition, Go, progress, Cancel;
 *   the set-safety warnings of the playing deck, and which deck carries a key shift the
 *   co-pilot applied.
 *
 * Zero scroll: the list shows as many rows as fit above (or below) the button, first with the
 * reasons on a second line, then one line per row, then fewer rows (`fitRows`).
 *
 * Keyboard: nothing in here is natively `disabled` while it can hold focus (`soft`), and when
 * the focused control is replaced (Mix becomes Go, a row leaves the list) focus moves to what
 * replaced it (`data-cp-slot`, `slotCandidates`) instead of falling to `<body>`. Arrow keys move
 * through the suggestion list and the radio rows; no arrow pressed in the popover reaches the
 * app's global shortcuts (CopilotButton stops them at the popup).
 *
 * Mounted only while the popover is open. It subscribes to compact keys (which deck holds what,
 * whole percents of the progress, half bars), never to the engine snapshot itself.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { Blend, CornerDownLeft, Info, Play, Sparkles, TriangleAlert, X } from "lucide-react";
import type { EnergyDirection, PlanInfo, TransitionStyle } from "@/bridge/copilot";
import type { DeckId } from "@/bridge/types";
import { KeyChip } from "@/components/KeyChip";
import { RadioCells } from "@/components/deck-tabs/RadioCells";
import { soft } from "@/components/deck-tabs/soft-disabled";
import { useLocale, useT, type MessageKey, type Translate } from "@/i18n";
import { formatSemitones } from "@/lib/perf";
import { useClockPoll } from "@/lib/use-clock-poll";
import { DeckLetter } from "@/library/LibraryRows";
import { useLibraryPool } from "@/library/pool-store";
import { fmtBpm } from "@/library/track-view";
import { useHistoryStore } from "@/state/history-store";
import { useMixerStore } from "@/state/mixer-store";
import { usePerfStore } from "@/state/perf-store";
import { IN_POPOUT, MAX_ASK, MAX_SUGGESTIONS, scheduleRefresh, useCopilotStore, type Note, type Suggestion } from "./copilot-store";
import { SHIFT_COL, barsUntil, controlMin, decksKey, fitRows, listMoveIn, otherDeck, rowReasons, shiftButtonSoft, shiftButtonState, shiftsKey, type ShiftButtonState } from "./features.ts";
import { keyVerdict, proposalOf } from "./key-shift.ts";
import type { SetFilters } from "./set-builder.ts";
import { slotCandidates, warningText } from "./texts.ts";
import { useCount } from "./use-count.ts";

const LOAD_DECKS: readonly DeckId[] = ["a", "b"];
const ALL_DECKS: readonly DeckId[] = ["a", "b", "c", "d"];
const ENERGIES: readonly EnergyDirection[] = ["hold", "up", "down"];
const STYLES: readonly TransitionStyle[] = ["bass_swap", "filter_sweep", "echo_out", "stem_swap", "cut"];
const BAR_CHOICES: readonly number[] = [0, 4, 8, 16, 32];
/** Space the popover needs around the body: offset from the button, padding, title, margin to the window edge. */
const POPOVER_CHROME = 58;

const REASON_KEY: Record<string, MessageKey> = {
    key_same: "copilot.reason.key_same",
    key_relative: "copilot.reason.key_relative",
    key_adjacent: "copilot.reason.key_adjacent",
    key_boost: "copilot.reason.key_boost",
    key_diagonal: "copilot.reason.key_diagonal",
    key_clash: "copilot.reason.key_clash",
    key_shiftable: "copilot.reason.key_shiftable",
    key_unknown: "copilot.reason.key_unknown",
    tempo_close: "copilot.reason.tempo_close",
    tempo_far: "copilot.reason.tempo_far",
    energy_hold: "copilot.reason.energy_hold",
    energy_up: "copilot.reason.energy_up",
    energy_down: "copilot.reason.energy_down",
    energy_shift: "copilot.reason.energy_shift",
    energy_jump: "copilot.reason.energy_jump",
    energy_against: "copilot.reason.energy_against",
    energy_unknown: "copilot.reason.energy_unknown",
    recently_played: "copilot.reason.recently_played",
    same_artist: "copilot.reason.same_artist",
    stems_ready: "copilot.reason.stems_ready",
};

const WHY_KEY: Record<string, MessageKey> = {
    style_requested: "copilot.why.style_requested",
    tempo_gap_echo: "copilot.why.tempo_gap_echo",
    key_clash_echo: "copilot.why.key_clash_echo",
    stems_available: "copilot.why.stems_available",
    harmonic_long_blend: "copilot.why.harmonic_long_blend",
    short_filter_blend: "copilot.why.short_filter_blend",
    bar_aligned_short_track: "copilot.why.bar_aligned_short_track",
    shortened_to_fit: "copilot.why.shortened_to_fit",
    phrase_aligned: "copilot.why.phrase_aligned",
};

/** Translated tags; a tag this build does not know is shown as it came (words, no underscores). */
function tagText(t: Translate, table: Record<string, MessageKey>, tag: string): string {
    const key = table[tag];
    return key ? t(key) : tag.replace(/_/g, " ");
}

/**
 * A held Enter repeats: without this, holding it on "Mix next" would plan and then press the
 * "Go" that takes its place (and holding it on "Go" would press "Cancel"). Only a fresh key
 * press activates a button of the transition section.
 */
function noRepeat(e: KeyboardEvent<HTMLButtonElement>): void {
    if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
}

// ─── (a) Ask ────────────────────────────────────────────────────────────────

function AskField() {
    const t = useT();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (busy || text.trim().length === 0) return;
        setBusy(true);
        void useCopilotStore
            .getState()
            .ask(text)
            .finally(() => setBusy(false));
    };
    return (
        <form className="cp-ask" onSubmit={submit} aria-busy={busy || undefined}>
            <label className="cp-ask-field" title={t("copilot.askHint")}>
                <Sparkles size={12} aria-hidden />
                <input
                    type="text"
                    value={text}
                    maxLength={MAX_ASK * 2}
                    data-cp-slot="ask"
                    onChange={(e) => setText(e.target.value)}
                    placeholder={t("copilot.askPlaceholder")}
                    aria-label={t("copilot.ask")}
                    autoComplete="off"
                    spellCheck={false}
                />
            </label>
            {/* Never natively disabled: a click puts focus here, and `submit` ignores an empty or busy request. */}
            <button type="submit" className="dk-btn dk-btn-icon" aria-label={t("copilot.askRun")} title={t("copilot.askRun")} aria-disabled={busy || text.trim().length === 0 || undefined}>
                <CornerDownLeft size={12} aria-hidden />
            </button>
        </form>
    );
}

function filterChips(t: Translate, f: SetFilters): string[] {
    const out: string[] = [];
    if (f.words.length > 0) out.push(t("copilot.f.text", { words: f.words.join(" ") }));
    if (f.bpmMin !== null && f.bpmMax !== null) out.push(t("copilot.f.bpm", { min: f.bpmMin, max: f.bpmMax }));
    else if (f.bpmMin !== null) out.push(t("copilot.f.bpmMin", { min: f.bpmMin }));
    else if (f.bpmMax !== null) out.push(t("copilot.f.bpmMax", { max: f.bpmMax }));
    if (f.yearMin !== null && f.yearMax !== null) out.push(t("copilot.f.years", { from: f.yearMin, to: f.yearMax }));
    if (f.keyRelation) out.push(t(`copilot.f.key.${f.keyRelation}`));
    if (f.energyDirection) out.push(t(`copilot.f.energy.${f.energyDirection}`));
    if (f.stems) out.push(t("copilot.f.stems"));
    if (f.favorites) out.push(t("copilot.f.favorites"));
    if (f.fresh) out.push(t("copilot.f.fresh"));
    return out;
}

/** The active set-builder request: what was understood, how many tracks pass, and a way out. */
function RequestLine() {
    const t = useT();
    const request = useCopilotStore((s) => s.request);
    const searched = useLibraryPool((s) => s.tracks.length);
    if (!request) return null;
    const chips = filterChips(t, request.filters);
    return (
        <div className="cp-request" role="group" aria-label={t("copilot.request")}>
            <span className="dk-label">{t("copilot.request")}</span>
            <span className="cp-chips" title={request.text}>
                {chips.map((c) => (
                    <span key={c} className="cp-chip">
                        {c}
                    </span>
                ))}
            </span>
            <span className="dk-num dk-num-sm cp-count">{t("copilot.requestMatched", { n: request.matched, total: searched })}</span>
            <button type="button" className="dk-btn dk-btn-icon" data-cp-slot="request" aria-label={t("copilot.clearRequest")} title={t("copilot.clearRequest")} onClick={() => useCopilotStore.getState().clearRequest()}>
                <X size={12} aria-hidden />
            </button>
        </div>
    );
}

/**
 * The co-pilot works on the rows the Library has loaded (at most its page limit, in its current
 * search and sort order). When the library holds more, say so: a request over "the library"
 * otherwise looks complete while it covered the first rows only.
 */
function PoolNote() {
    const t = useT();
    const locale = useLocale();
    const count = useCount();
    const searched = useLibraryPool((s) => s.tracks.length);
    // `total` = what the companion reports for the Library's search (absent on an older pool store).
    const total = useLibraryPool((s) => (s as { total?: number }).total ?? s.tracks.length);
    const fmt = useMemo(() => new Intl.NumberFormat(locale), [locale]);
    if (searched === 0 || !(total > searched)) return null;
    return (
        <p className="cp-pool" data-cp-pool="">
            <Info size={11} aria-hidden />
            <span>{t("copilot.poolPartial", { n: fmt.format(searched), tracks: count("tracks", total) })}</span>
        </p>
    );
}

// ─── (b) Next track ─────────────────────────────────────────────────────────

/**
 * "Load on the incoming deck and shift the key": the one control that changes how a track
 * sounds, so its name says the track, the deck, the shift and the key it gives. Visible text:
 * the deck letter and the shift ("B+1"); while its load is in flight the shift is replaced by
 * "…" (the key follows the moment the engine has the track). Never natively `disabled`: in
 * flight, done (the track is there with this shift) and "the deck is playing" show it
 * `aria-disabled` and focusable, and its name says which of the three it is
 * (`shiftButtonState`). A press while in flight or while the deck plays is answered in the
 * status line ("still loading", "deck B is playing"), not with silence; only "done" has
 * nothing left to do.
 */
const SHIFT_LABEL: Record<Exclude<ShiftButtonState, "none">, MessageKey> = {
    load: "copilot.loadShift",
    shift: "copilot.shiftOnly",
    busy: "copilot.shiftLoading",
    done: "copilot.shiftApplied",
    playing: "copilot.shiftOffPlaying",
};

function ShiftButton({ track, title, index, deck, shift, keyAfter, state }: { track: Suggestion["track"]; title: string; index: number; deck: DeckId; shift: number; keyAfter: string; state: Exclude<ShiftButtonState, "none"> }) {
    const t = useT();
    const vars = { title, deck: deck.toUpperCase(), shift: formatSemitones(shift), key: keyAfter };
    const label = t(SHIFT_LABEL[state], vars);
    return (
        <button
            type="button"
            className="dk-btn dk-btn-xs cp-row-shift"
            data-col={SHIFT_COL}
            data-cp-slot={`row:${index}:${SHIFT_COL}`}
            data-state={state}
            aria-label={label}
            title={label}
            aria-busy={state === "busy" || undefined}
            aria-disabled={shiftButtonSoft(state) || undefined}
            /* The store refuses a press in flight or on a playing deck and says why. */
            onClick={state === "done" ? undefined : () => void useCopilotStore.getState().loadShifted(deck, track, shift)}
        >
            <DeckLetter deck={deck} />
            <span className="dk-num" aria-hidden>
                {state === "busy" ? "…" : formatSemitones(shift)}
            </span>
        </button>
    );
}

/**
 * One suggestion. `against` = the key the list was ranked against (the reference deck as it
 * sounds); `target` = the deck a "load with key shift" goes to (null = no such button);
 * `targetHolds` = track id on that deck; `shifted` = the co-pilot's key shift on that deck for
 * that track (0 = none); `targetPlaying` = that deck is playing; `loading` = id of the track a
 * "load with key shift" is bringing to that deck right now ("" = none).
 */
function SuggestionRow({
    s,
    index,
    dense,
    against,
    holders,
    target,
    targetHolds,
    shifted,
    targetPlaying,
    loading,
}: {
    s: Suggestion;
    index: number;
    dense: boolean;
    against: string | null;
    holders: readonly string[];
    target: DeckId | null;
    targetHolds: string;
    shifted: number;
    targetPlaying: boolean;
    loading: string;
}) {
    const t = useT();
    const tr = s.track;
    const id = String(tr.id);
    const title = (tr.title ?? "").trim() || tr.filename;
    const artist = tr.artist?.trim() || t("copilot.unknownArtist");
    const pct = s.ranked ? Math.min(100, Math.max(0, Math.round(s.ranked.score * 100))) : null;
    // A shell without proposals sends no such fields: `proposal` is null and the row is the old one.
    const proposal = proposalOf(s.ranked);
    const { shift: tagged, rest } = rowReasons(s.ranked?.reasons ?? []);
    // The key-shift reason comes first, before the score: it says the shift and the key it gives.
    const shiftText = proposal ? t("copilot.reason.keyShift", { shift: formatSemitones(proposal.shift), key: proposal.key }) : tagged ? t("copilot.reason.key_shiftable") : null;
    const why = [shiftText, pct !== null ? t("copilot.score", { pct }) : null, ...rest.map((r) => tagText(t, REASON_KEY, r))].filter(Boolean).join(" · ");
    const onTarget = target !== null && targetHolds === id;
    // No button in a pop-out window (see IN_POPOUT): the reason text above still says the shift.
    const state = shiftButtonState({ popout: IN_POPOUT, proposal: proposal !== null, target: target !== null, onTarget, applied: proposal !== null && shifted === proposal.shift, busy: loading === id, targetPlaying });
    return (
        <li className="cp-row" data-dense={dense} data-shift={state !== "none" ? "" : undefined}>
            <span className="cp-row-text cp-c" title={why ? `${title} · ${artist}\n${why}` : `${title} · ${artist}`}>
                {title} <span className="cp-row-artist">· {artist}</span>
            </span>
            {proposal && target && state !== "none" && <ShiftButton track={tr} title={title} index={index} deck={target} shift={proposal.shift} keyAfter={proposal.key} state={state} />}
            <span className="dk-num dk-num-sm cp-row-bpm">{fmtBpm(tr.bpm)}</span>
            {/* The track's own key, never the shifted one: the reason line and the button say what a
                shift gives. Its mark is the co-pilot's own verdict (the score the ranking used), not
                the Library's: the chip never says "workable" next to "Key +1 fits". */}
            <KeyChip keyName={tr.keyCamelot} against={against} verdict={keyVerdict(tr.keyCamelot, against)} />
            {LOAD_DECKS.map((deck, i) => {
                const on = holders[i] === id;
                const label = on ? t("copilot.onDeck", { deck: deck.toUpperCase() }) : t("copilot.loadTo", { title, deck: deck.toUpperCase() });
                // `soft`, never `disabled`: the button that was just pressed keeps the focus.
                return (
                    <button
                        key={deck}
                        type="button"
                        className="dk-btn dk-btn-xs cp-row-load"
                        data-col={i}
                        data-cp-slot={`row:${index}:${i}`}
                        aria-label={label}
                        title={label}
                        {...soft(on, () => void useCopilotStore.getState().load(deck, tr))}
                    >
                        <DeckLetter deck={deck} />
                    </button>
                );
            })}
            {!dense && why && <span className="cp-row-why cp-c">{why}</span>}
            {dense && why && <span className="sr-only">{why}</span>}
        </li>
    );
}

function NextTracks({ rows, dense, listRef }: { rows: number; dense: boolean; listRef: RefObject<HTMLUListElement | null> }) {
    const t = useT();
    const available = useCopilotStore((s) => s.available);
    const refDeck = useCopilotStore((s) => s.refDeck);
    const suggestions = useCopilotStore((s) => s.suggestions);
    const ranking = useCopilotStore((s) => s.ranking);
    const energy = useCopilotStore((s) => s.energy);
    const hasRequest = useCopilotStore((s) => s.request !== null);
    const poolSize = useLibraryPool((s) => s.tracks.length);
    // The key the list on screen was ranked against (the reference deck as it sounds, its key
    // shift applied): the chips of the rows compare against the same key as the ranking did.
    const against = useCopilotStore((s) => s.refKey);
    // Track id on deck A and B ("" = empty), as one string: changes on a load only.
    const held = useMixerStore((s) => LOAD_DECKS.map((id) => (s.deck(id).loaded ? (s.deck(id).trackId ?? "") : "")).join("\u0001"));
    const holders = useMemo(() => held.split("\u0001"), [held]);
    // Where a "load with key shift" goes: the incoming deck, by the rule "Mix next" uses.
    const target = useMixerStore((s) => (refDeck ? otherDeck(refDeck, s.decks) : null));
    const targetHolds = useMixerStore((s) => (target && s.deck(target).loaded ? (s.deck(target).trackId ?? "") : ""));
    // That deck is playing: the key-shift buttons go soft (a boolean: it changes on play / pause only).
    const targetPlaying = useMixerStore((s) => (target ? s.deck(target).loaded && s.deck(target).playing : false));
    // The co-pilot's own key shift on that deck (0 = none) and the track it was set for.
    const applied = useCopilotStore((s) => s.shifts.find((r) => r.deck === target) ?? null);
    // Id of the track a "load with key shift" is bringing to that deck right now ("" = none).
    const loading = useCopilotStore((s) => (target ? (s.shifting[target] ?? "") : ""));
    const heading = refDeck ? t("copilot.nextFor", { deck: refDeck.toUpperCase() }) : t("copilot.next");
    const shown = suggestions.slice(0, rows);
    // Which rows have the key-shift button (it stands before Load A and Load B on screen); a
    // pop-out window has none.
    const hasShift = shown.map((s) => !IN_POPOUT && target !== null && proposalOf(s.ranked) !== null);
    // Arrow keys walk the buttons: Up / Down between rows, Left / Right along the row.
    const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const at = /^row:(\d+):(\d+)$/.exec((e.target as HTMLElement).closest?.("[data-cp-slot]")?.getAttribute("data-cp-slot") ?? "");
        if (!at) return;
        const next = listMoveIn(e.key, Number(at[1]), Number(at[2]), hasShift);
        if (!next) return;
        // Handled here: the key is not a global shortcut (arrows = crossfader) and does not scroll.
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.querySelector<HTMLElement>(`[data-cp-slot="row:${next.row}:${next.col}"]`)?.focus();
    };
        // A request works without the shell (its matches are listed unranked); suggestions do not.
        const empty = hasRequest
                ? t(poolSize === 0 ? "copilot.empty.noLibrary" : "copilot.empty.noMatch")
                : available === "no"
                    ? t("copilot.unavailable")
                    : poolSize === 0
                        ? t("copilot.empty.noLibrary")
                        : refDeck
                            ? t("copilot.empty.noMatch")
                            : t("copilot.empty.noDeck");
    return (
        <section className="cp-sec" aria-label={heading}>
            <div className="cp-head">
                <span className="dk-label cp-c">{heading}</span>
                <RadioCells
                    label={t("copilot.energyAria")}
                    groupClass="cp-radios"
                    value={energy}
                    options={ENERGIES.map((e) => ({ value: e, label: t(`copilot.energy.${e}`), title: t(`copilot.energyTip.${e}`) }))}
                    onChange={(e) => useCopilotStore.getState().setEnergy(e)}
                />
            </div>
            {shown.length > 0 ? (
                <ul ref={listRef} className="cp-list" aria-busy={ranking || undefined} onKeyDown={onListKey}>
                    {shown.map((s, i) => (
                        <SuggestionRow
                            key={s.track.id}
                            s={s}
                            index={i}
                            dense={dense}
                            against={against}
                            holders={holders}
                            target={target}
                            targetHolds={targetHolds}
                            shifted={applied && applied.trackId === String(s.track.id) ? applied.shift : 0}
                            targetPlaying={targetPlaying}
                            loading={loading}
                        />
                    ))}
                </ul>
            ) : (
                <p className="cp-empty" role="status">
                    {ranking ? t("copilot.ranking") : empty}
                </p>
            )}
        </section>
    );
}

// ─── (c) Mix next ───────────────────────────────────────────────────────────

function PlanView({ plan }: { plan: PlanInfo }) {
    const t = useT();
    const count = useCount();
    const opts = useCopilotStore((s) => s.planOpts);
    const planning = useCopilotStore((s) => s.planning);
    // Half bars from the live playhead to the planned start: changes about once a second while playing.
    const startBars = useMixerStore((s) => {
        const d = s.deck(plan.fromDeck);
        return barsUntil(plan, d.position, d.bpm);
    });
    const why = plan.reasons.map((r) => tagText(t, WHY_KEY, r)).join(" · ");
    const line = t("copilot.planLine", { from: plan.fromDeck.toUpperCase(), to: plan.toDeck.toUpperCase(), style: t(`copilot.style.${plan.style}`), bars: count("bars", plan.bars) });
    const setOpts = useCopilotStore.getState().setPlanOpts;
    return (
        <div className="cp-plan" aria-busy={planning || undefined}>
            <p className="cp-plan-line">{line}</p>
            <p className="cp-plan-sub">
                <span className="dk-num">{startBars > 0 ? t("copilot.startsIn", { bars: count("bars", startBars) }) : t("copilot.startsNow")}</span>
                {why && <span className="cp-plan-why"> · {why}</span>}
            </p>
            <div className="cp-opt">
                <span className="dk-label">{t("copilot.barsLabel")}</span>
                <RadioCells
                    label={t("copilot.barsAria")}
                    groupClass="cp-radios"
                    value={opts.bars ?? 0}
                    options={BAR_CHOICES.map((n) => ({ value: n, label: n === 0 ? t("copilot.auto") : String(n), ariaLabel: n === 0 ? t("copilot.auto") : count("bars", n) }))}
                    onChange={(n) => setOpts({ ...opts, bars: n > 0 ? n : null })}
                />
            </div>
            <RadioCells
                label={t("copilot.styleAria")}
                groupClass="cp-radios cp-styles"
                value={opts.style ?? "auto"}
                options={[
                    { value: "auto" as const, label: t("copilot.auto") },
                    ...STYLES.map((s) => ({ value: s, label: t(`copilot.styleShort.${s}`), ariaLabel: t(`copilot.style.${s}`), title: t(`copilot.style.${s}`) })),
                ]}
                onChange={(s) => setOpts({ ...opts, style: s === "auto" ? null : s })}
            />
            <div className="cp-actions">
                <button type="button" className="dk-btn cp-go" data-cp-slot="mix" title={t("copilot.goTip")} onKeyDown={noRepeat} {...soft(planning, () => void useCopilotStore.getState().go())}>
                    <Play size={12} aria-hidden />
                    {t("copilot.go")}
                </button>
                <button type="button" className="dk-btn dk-btn-xs" data-cp-slot="mix2" onKeyDown={noRepeat} onClick={() => useCopilotStore.getState().dropPlan()}>
                    {t("copilot.discard")}
                </button>
            </div>
        </div>
    );
}

function RunView() {
    const t = useT();
    const count = useCount();
    // Whole percents and whole beats: about ten updates a second at most, only while a transition runs.
    const pct = useCopilotStore((s) => Math.round((s.run?.progress ?? 0) * 100));
    const waiting = useCopilotStore((s) => s.run?.waiting ?? false);
    const beats = useCopilotStore((s) => Math.ceil(s.run?.beatsUntilStart ?? 0));
    const from = useCopilotStore((s) => s.run?.fromDeck ?? "a");
    const to = useCopilotStore((s) => s.run?.toDeck ?? "b");
    const text = waiting ? t("copilot.waiting", { beats: count("beats", beats) }) : t("copilot.running", { from: from.toUpperCase(), to: to.toUpperCase() });
    return (
        <div className="cp-run">
            <p className="cp-plan-line">
                <span>{text}</span>
                <span className="dk-num dk-num-sm" aria-hidden>
                    {pct}%
                </span>
            </p>
            <div className="cp-progress" role="progressbar" aria-label={t("copilot.progressAria")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={`${text}, ${pct}%`}>
                <i style={{ width: `${pct}%` }} />
            </div>
            <div className="cp-actions">
                <button type="button" className="dk-btn" data-cp-slot="mix" title={t("copilot.cancelTip")} onKeyDown={noRepeat} onClick={() => void useCopilotStore.getState().cancel()}>
                    <X size={12} aria-hidden />
                    {t("copilot.cancel")}
                </button>
            </div>
        </div>
    );
}

function MixSection() {
    const t = useT();
    const available = useCopilotStore((s) => s.available);
    const plan = useCopilotStore((s) => s.plan);
    const planning = useCopilotStore((s) => s.planning);
    const running = useCopilotStore((s) => s.run !== null);
    return (
        <section className="cp-sec" aria-label={t("copilot.mixSection")}>
            {running ? (
                <RunView />
            ) : plan ? (
                <PlanView plan={plan} />
            ) : (
                <div className="cp-actions">
                    <button
                        type="button"
                        className="dk-btn"
                        data-cp-slot="mix"
                        title={t("copilot.mixTip")}
                        aria-busy={planning || undefined}
                        onKeyDown={noRepeat}
                        {...soft(available === "no" || planning, () => void useCopilotStore.getState().planMix())}
                    >
                        <Blend size={12} aria-hidden />
                        {planning ? t("copilot.planning") : t("copilot.mix")}
                    </button>
                </div>
            )}
        </section>
    );
}

// ─── Safety + status ────────────────────────────────────────────────────────

/** The warnings as a list. They are ANNOUNCED by CopilotButton (it is mounted while the popover is closed too). */
function Warnings() {
    const t = useT();
    const locale = useLocale();
    const count = useCount();
    const warnings = useCopilotStore((s) => s.warnings);
    const num = useMemo(() => {
        const fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
        return (n: number) => fmt.format(n);
    }, [locale]);
    if (warnings.length === 0) return null;
    return (
        <ul className="cp-warns" aria-label={t("copilot.safety")}>
            {warnings.map((w) => (
                <li key={w.code} className="dk-label cp-warn" data-sev={w.severity}>
                    {w.severity >= 2 ? <TriangleAlert size={11} aria-hidden /> : <Info size={11} aria-hidden />}
                    <span>
                        <span className="sr-only">{t(w.severity >= 2 ? "copilot.sev.2" : "copilot.sev.1")}: </span>
                        {warningText(t, w, count, num)}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/**
 * The status line, and the ONE polite live region of the popover: always mounted with the same
 * role, so a message that appears is announced whatever its tone (switching the role together
 * with the text is not announced reliably). An error says so in words, not by role or colour.
 * (`ShiftLines` below is a second, separate region for a standing fact, not for messages.)
 */
function NoteLine({ note }: { note: Note | null }) {
    const t = useT();
    const count = useCount();
    const vars = note ? { ...note.vars, ...Object.fromEntries(Object.entries(note.counts ?? {}).map(([name, c]) => [name, count(c.kind, c.n)])) } : undefined;
    return (
        <p className="cp-note" role="status" aria-live="polite" aria-atomic="true" data-tone={note?.tone} data-empty={note ? undefined : ""} title={note?.detail}>
            {note && (note.tone === "error" ? <TriangleAlert size={12} aria-hidden /> : <Info size={12} aria-hidden />)}
            {note && (
                <span>
                    {note.tone === "error" && <span className="sr-only">{t("copilot.errorPrefix")}: </span>}
                    {t(note.key, vars)}
                </span>
            )}
        </p>
    );
}

/**
 * Which deck carries a key shift the co-pilot applied, for as long as it does ("Deck B: key
 * +1 ..."): a standing line, not a message that goes away, because the shift changes how that
 * deck sounds until its next track. Its own polite region, always mounted (empty = out of the
 * layout), so the line is announced when it appears and again when the shift changes.
 */
function ShiftLines() {
    const t = useT();
    const shifts = useCopilotStore((s) => s.shifts);
    const lines = ALL_DECKS.flatMap((deck) => {
        const r = shifts.find((x) => x.deck === deck);
        return r ? [{ deck, text: t("copilot.shiftOn", { deck: deck.toUpperCase(), shift: formatSemitones(r.shift) }) }] : [];
    });
    return (
        <p className="cp-shifts" role="status" aria-live="polite" aria-atomic="true" data-cp-shifts="" data-empty={lines.length > 0 ? undefined : ""}>
            {lines.map((l) => (
                <span key={l.deck} className="cp-shift-line">
                    <Info size={12} aria-hidden />
                    <span>{l.text}</span>
                </span>
            ))}
        </p>
    );
}

/**
 * Keep keyboard focus inside the popover when the focused control is taken out of the page
 * (Mix is replaced by Go, Go by Cancel, the plan is dropped, a row leaves the list): focus goes
 * to the control that took its place (`data-cp-slot`), not to `<body>`, from where the next Tab
 * would start at the top of the app and the next arrow key would move the crossfader.
 *
 * The popover's own focus manager (Base UI) also reacts to a removed focused element: it parks
 * focus on the popup container, and does so again one frame after this hook has moved it
 * (measured in the app: hand-over at 2145 ms, taken back at 2147 ms). So the hand-over is
 * asserted again over the next frames while focus sits on that container or on `<body>`, and
 * stops the moment the user's focus is anywhere else. Bounded: a handful of tries, then it
 * gives up (focus is then on the popover container, still inside the popover).
 */
function useKeepFocus(bodyRef: RefObject<HTMLElement | null>): void {
    useEffect(() => {
        const body = bodyRef.current;
        if (!body || typeof MutationObserver === "undefined") return;
        let last: { el: Element; slot: string } | null = null;
        let timers: number[] = [];
        const stop = () => {
            for (const id of timers) window.clearTimeout(id);
            timers = [];
        };
        /** Focus is nowhere useful: on `<body>`, or on a container around the popover's content. */
        const lost = () => {
            const active = document.activeElement;
            return !active || active === document.body || (active !== body && active.contains(body));
        };
        const onFocusIn = (e: FocusEvent) => {
            const el = e.target instanceof Element ? e.target.closest("[data-cp-slot]") : null;
            if (el) last = { el, slot: el.getAttribute("data-cp-slot") ?? "" };
            // Focus on something of the popover that is not a slot: the user went there.
            else if (e.target instanceof Element && body.contains(e.target)) last = null;
        };
        // Focus left a control that is still in the page: the user moved on (a click on empty
        // space, another window). Only a control that was REMOVED hands its focus on. Checked a
        // moment later: some webviews send this event while the element is being removed.
        const onFocusOut = (e: FocusEvent) => {
            const was = last;
            if (!was || e.target !== was.el) return;
            window.setTimeout(() => {
                if (last === was && was.el.isConnected && document.activeElement !== was.el) last = null;
            }, 0);
        };
        /** Move focus to the control in the slot (or its fallbacks); false = nothing to focus. */
        const handOver = (slot: string): boolean => {
            const rows = body.querySelectorAll(".cp-row").length;
            for (const candidate of slotCandidates(slot, rows)) {
                const next = body.querySelector<HTMLElement>(`[data-cp-slot="${candidate}"]`);
                if (next) {
                    next.focus();
                    return true;
                }
            }
            return false;
        };
        const restore = () => {
            // Still in the page: the user moved on by themselves (or nothing happened).
            if (!last || last.el.isConnected) return;
            if (!lost()) {
                last = null;
                return;
            }
            const slot = last.slot;
            stop();
            if (!handOver(slot)) return;
            // The focus manager takes focus back after its own frame: hold the hand-over.
            for (const delay of [0, 16, 48, 120, 250]) {
                timers.push(
                    window.setTimeout(() => {
                        if (lost()) handOver(slot);
                    }, delay),
                );
            }
        };
        // The user acted (Tab, a pointer press): from here on focus is theirs. Without this a
        // Tab pressed inside the 250 ms window could land on the popup container and be pulled
        // back to the slot.
        const root = body.closest<HTMLElement>('[role="dialog"]') ?? body;
        const onUserKey = (e: globalThis.KeyboardEvent) => {
            if (e.key === "Tab") stop();
        };
        body.addEventListener("focusin", onFocusIn);
        body.addEventListener("focusout", onFocusOut);
        root.addEventListener("keydown", onUserKey, true);
        root.addEventListener("pointerdown", stop, true);
        const mo = new MutationObserver(restore);
        mo.observe(body, { childList: true, subtree: true });
        return () => {
            stop();
            mo.disconnect();
            body.removeEventListener("focusin", onFocusIn);
            body.removeEventListener("focusout", onFocusOut);
            root.removeEventListener("keydown", onUserKey, true);
            root.removeEventListener("pointerdown", stop, true);
        };
    }, [bodyRef]);
}

// ─── Popover body ───────────────────────────────────────────────────────────

export function CopilotPopover() {
    // The reference deck follows the master clock: keep the clock fresh while the popover is open.
    useClockPoll();
    const note = useCopilotStore((s) => s.note);
    const count = useCopilotStore((s) => s.suggestions.length);
    const clockSource = usePerfStore((s) => s.clock?.source ?? null);
    // One string for "which deck holds what, plays, at what tempo and key": not every snapshot.
    const decks = useMixerStore((s) => decksKey(s.decks, null, s.deckKeys));
    const played = useHistoryStore((s) => s.played);
    // A deck's whole key shift changes the key it sounds in: the list is ranked against that key.
    const shifts = usePerfStore((s) => shiftsKey(s.decks));

    // Rank again when the decks, their key shifts, the master deck or the play history change (the open itself ranks once).
    const first = useRef(true);
    useEffect(() => {
        // A plan belongs to the two tracks it was made for.
        useCopilotStore.getState().checkPlan();
        if (first.current) {
            first.current = false;
            return;
        }
        scheduleRefresh();
    }, [decks, clockSource, played, shifts]);

    // Rows that fit without scrolling, from the room above / below the button.
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<HTMLUListElement | null>(null);
    const [fit, setFit] = useState({ rows: MAX_SUGGESTIONS, dense: false });
    useKeepFocus(bodyRef);
    useLayoutEffect(() => {
        const body = bodyRef.current;
        if (!body) return;
        const measure = () => {
            const r = document.querySelector<HTMLElement>("[data-cp-trigger]")?.getBoundingClientRect();
            const room = r ? Math.max(r.top, window.innerHeight - r.bottom) : window.innerHeight;
            const fixed = body.offsetHeight - (listRef.current?.offsetHeight ?? 0);
            // The size the stylesheet builds the rows from (24 px, 44 px in touch mode).
            const min = controlMin(getComputedStyle(body).getPropertyValue("--cp-min"));
            const next = fitRows(room - POPOVER_CHROME, fixed, count, min);
            setFit((p) => (p.rows === next.rows && p.dense === next.dense ? p : next));
        };
        measure();
        window.addEventListener("resize", measure);
        if (typeof ResizeObserver === "undefined") return () => window.removeEventListener("resize", measure);
        const ro = new ResizeObserver(measure);
        ro.observe(body);
        return () => {
            ro.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [count]);

    return (
        <div ref={bodyRef} className="cp-body">
            <AskField />
            <RequestLine />
            <PoolNote />
            <NextTracks rows={fit.rows} dense={fit.dense} listRef={listRef} />
            <MixSection />
            <Warnings />
            <ShiftLines />
            <NoteLine note={note} />
        </div>
    );
}
