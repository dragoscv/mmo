/**
 * Status-bar item of LAN tempo sync (rendered by shell/StatusBar.tsx) and its popover.
 *
 * Chip: "LINK" + state dot (ring = off, half = searching, filled = locked) and, while sync runs,
 * the number of other instances and the role word. Every part selects one value of the store,
 * so the 4 Hz status of a running session renders only what changed; a stopped session sends
 * nothing and renders nothing.
 *
 * Focus rule of the popover: a control that may hold keyboard focus is never switched off with
 * the native `disabled` (the browser then drops focus to <body>, and the popover is left with
 * no focused element). Fields become read-only, buttons get `aria-disabled` and ignore the
 * press; the reason is always a visible sentence next to them.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@mmo/ui";
import { useT, type MessageKey } from "@/i18n";
import { consumeBareArrows } from "@/remote/remote-core";
import { bpmText, cleanPin, linkPhase, nudgeText, offsetUnit, offsetValueText, parseBpm, type LinkPhase } from "./link-math";
import { useLinkStore } from "./link-store";

type ChipState = LinkPhase | "unavailable";

const STATE_TEXT: Record<ChipState, MessageKey> = {
    off: "link.state.off",
    searching: "link.state.searching",
    locked: "link.state.locked",
    unavailable: "link.state.unavailable",
};

/** One nudge step of the popover buttons, in beats. */
const NUDGE_STEP = 0.25;

/**
 * Status-bar fit (shell/StatusBar.tsx `useFit`): parts with `data-prio` are hidden when the bar
 * is too narrow, the highest number first. The chip itself carries it only while sync is OFF:
 * a running session must always have its way to Stop on screen. While it runs, only the two
 * optional texts of the chip can go (they go before the library item, prio 40).
 */
const PRIO_CHIP_OFF = 45;
const PRIO_ROLE = 45;
const PRIO_PEERS = 44;

function useChipState(): ChipState {
    return useLinkStore((s) => (s.available === "no" ? "unavailable" : linkPhase(s.status)));
}

/** Session readouts: tempo, other instances, clock offset to the leader. */
function Stats() {
    const t = useT();
    const bpm = useLinkStore((s) => bpmText(s.status.bpm));
    const peers = useLinkStore((s) => s.status.peers);
    const pending = useLinkStore((s) => s.status.pending);
    const offset = useLinkStore((s) => offsetValueText(s.status.offsetUs));
    const unit = useLinkStore((s) => offsetUnit(s.status.offsetUs));
    return (
        <dl className="lk-stats">
            <div>
                <dt className="dk-label">{t("link.bpm")}</dt>
                <dd className="dk-num dk-num-md">{bpm}</dd>
            </div>
            <div>
                <dt className="dk-label">{t("link.peers")}</dt>
                <dd className="dk-num dk-num-md">
                    {peers}
                    {pending > 0 && <span className="lk-pending"> {t("link.pending", { n: pending })}</span>}
                </dd>
            </div>
            <div title={t("link.offsetTip")}>
                <dt className="dk-label">{t("link.offset")}</dt>
                <dd className="dk-num dk-num-md">{t(unit === "s" ? "link.offsetS" : "link.offsetMs", { v: offset })}</dd>
            </div>
        </dl>
    );
}

/**
 * Tempo proposal, phase nudge and re-align: the controls of a running session. `leadNoteId` =
 * the visible sentence that says why nudge is off while this instance leads.
 */
function SessionControls({ leadNoteId }: { leadNoteId: string }) {
    const t = useT();
    const nudge = useLinkStore((s) => nudgeText(s.status.nudgeBeats));
    const badBpm = useLinkStore((s) => s.error === "link.err.bpm");
    const leader = useLinkStore((s) => s.status.leader);
    const tempoLocked = useLinkStore((s) => s.status.tempoLocked);
    const [draft, setDraft] = useState("");
    const bpmId = useId();
    const lockId = useId();
    const empty = draft.trim() === "";
    const commit = () => {
        // Locked: the store answers with the reason (the sentence below the field says it too).
        if (empty && !tempoLocked) return;
        const bpm = parseBpm(draft);
        // An unusable value goes through as NaN: the store answers with the range message.
        void useLinkStore.getState().setTempo(bpm ?? Number.NaN);
        if (bpm !== null && !tempoLocked) setDraft("");
    };
    const doNudge = (beats: number) => void useLinkStore.getState().nudge(beats);
    return (
        <>
            <form
                className="lk-row"
                onSubmit={(e) => {
                    e.preventDefault();
                    commit();
                }}
            >
                <label className="dk-label" htmlFor={bpmId}>
                    {t("link.bpmField")}
                </label>
                <input
                    id={bpmId}
                    className="lk-input dk-num lk-bpm lk-push"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={draft}
                    readOnly={tempoLocked}
                    aria-invalid={badBpm || undefined}
                    aria-describedby={tempoLocked ? lockId : undefined}
                    onChange={(e) => setDraft(e.target.value)}
                />
                <button type="submit" className="dk-btn" aria-disabled={empty || tempoLocked || undefined} aria-describedby={tempoLocked ? lockId : undefined}>
                    {t("link.bpmSet")}
                </button>
            </form>
            {tempoLocked && (
                <p id={lockId} className="lk-note lk-reason" role="status">
                    {t(leader ? "link.tempoLocked.leader" : "link.tempoLocked.follow")}
                </p>
            )}
            <div className="lk-row" role="group" aria-label={t("link.nudge")}>
                <span className="dk-label" aria-hidden>
                    {t("link.nudge")}
                </span>
                <button type="button" className="dk-btn" aria-label={t("link.nudgeBack")} title={t("link.nudgeBack")} aria-disabled={leader || undefined} aria-describedby={leader ? leadNoteId : undefined} onClick={() => doNudge(-NUDGE_STEP)}>
                    {t("link.nudgeBackShort")}
                </button>
                <span className="dk-num dk-num-sm lk-nudge" role="status" aria-label={t("link.nudgeValue", { beats: nudge })}>
                    {nudge}
                </span>
                <button type="button" className="dk-btn" aria-label={t("link.nudgeFwd")} title={t("link.nudgeFwd")} aria-disabled={leader || undefined} aria-describedby={leader ? leadNoteId : undefined} onClick={() => doNudge(NUDGE_STEP)}>
                    {t("link.nudgeFwdShort")}
                </button>
                <button type="button" className="dk-btn lk-push" title={t("link.realignTip")} onClick={() => useLinkStore.getState().realign()}>
                    {t("link.realign")}
                </button>
            </div>
        </>
    );
}

/** Body of the popover (mounted only while it is open). */
function LinkPanel() {
    const t = useT();
    const state = useChipState();
    const busy = useLinkStore((s) => s.busy);
    const error = useLinkStore((s) => s.error);
    const pin = useLinkStore((s) => s.pin);
    const leader = useLinkStore((s) => s.status.leader);
    const pinSet = useLinkStore((s) => s.status.pinSet);
    const multicast = useLinkStore((s) => s.status.multicast);
    const pinId = useId();
    const hintId = useId();
    const roleNoteId = useId();
    if (state === "unavailable") {
        return (
            <p className="lk-note" role="status">
                {t("link.unavailable")}
            </p>
        );
    }
    const running = state !== "off";
    const { start, stop, setPin } = useLinkStore.getState();
    return (
        <div className="lk-body" data-link={state}>
            <div className="lk-row">
                <i className="sb-dot lk-dot" data-state={state} aria-hidden />
                <span className="lk-state" role="status">
                    {t(STATE_TEXT[state])}
                </span>
                {running && <strong className="lk-role">{t(leader ? "link.role.leader" : "link.role.follow")}</strong>}
                {/* The store ignores a press while a start or stop is on its way. */}
                <button type="button" className="dk-btn lk-push" data-on={running || undefined} aria-disabled={busy || undefined} onClick={() => void (running ? stop() : start())}>
                    {t(running ? "link.stop" : "link.start")}
                </button>
            </div>
            <div className="lk-field">
                <label className="dk-label" htmlFor={pinId}>
                    {t("link.pin")}
                </label>
                <input
                    id={pinId}
                    className="lk-input dk-num lk-pin"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    maxLength={4}
                    autoComplete="off"
                    value={pin}
                    // Read-only, not disabled: Enter starts sync from this field, and the
                    // field must keep the keyboard focus when it stops taking digits.
                    readOnly={running || busy}
                    aria-describedby={hintId}
                    aria-invalid={error === "link.err.pin" || undefined}
                    onChange={(e) => {
                        if (!running && !busy) setPin(cleanPin(e.target.value));
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !running && !busy) void start();
                    }}
                />
                <span id={hintId} className="lk-hint">
                    {running ? t(pinSet ? "link.pinOn" : "link.pinOpen") : t("link.pinHint")}
                </span>
            </div>
            {running && <Stats />}
            {running && <SessionControls leadNoteId={roleNoteId} />}
            {running && (
                <p id={roleNoteId} className="lk-note">
                    {t(leader ? "link.hint.leader" : "link.hint.follow")}
                </p>
            )}
            {running && !multicast && <p className="lk-note">{t("link.hint.local")}</p>}
            {error && (
                <p className="lk-error" role="alert">
                    {t(error)}
                </p>
            )}
        </div>
    );
}

/** Status-bar item of LAN tempo sync. */
export function LinkChip() {
    const t = useT();
    const state = useChipState();
    const peers = useLinkStore((s) => s.status.peers);
    const leader = useLinkStore((s) => s.status.leader);
    const [open, setOpen] = useState(false);
    const chipRef = useRef<HTMLButtonElement>(null);
    useEffect(() => useLinkStore.getState().init(), []);
    const running = state === "searching" || state === "locked";
    // The fit sets `hidden` by hand on parts with `data-prio`. If sync starts while the chip is
    // hidden (a narrow bar), the chip is no longer one of those parts: show it again here, the
    // fit then makes room by hiding parts that may go.
    useLayoutEffect(() => {
        if (running && chipRef.current?.hidden) chipRef.current.hidden = false;
    }, [running]);
    const role = t(leader ? "link.role.leader" : "link.role.follow");
    const label = running ? t("link.chipRunning", { state: t(STATE_TEXT[state]), role, n: peers }) : t("link.chipLabel", { state: t(STATE_TEXT[state]) });
    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                // Also how a shell that was replaced while the app ran is noticed.
                if (next) void useLinkStore.getState().refresh();
            }}
        >
            <PopoverTrigger ref={chipRef} className="sb-item lk-chip" data-prio={running ? undefined : PRIO_CHIP_OFF} data-link={state} aria-label={label} title={label}>
                <span className="dk-label" aria-hidden>
                    {t("link.chip")}
                </span>
                <i className="sb-dot" data-state={state} aria-hidden />
                {running && (
                    <span className="dk-num dk-num-sm" data-prio={PRIO_PEERS} aria-hidden>
                        {peers}
                    </span>
                )}
                {running && (
                    <strong className="sb-word" data-prio={PRIO_ROLE} aria-hidden>
                        {role}
                    </strong>
                )}
            </PopoverTrigger>
            {/* Bare arrows are the app's crossfader shortcuts: none may leave the popover unused. */}
            <PopoverContent
                side="top"
                align="end"
                className="lk-pop grid gap-2 p-3"
                onKeyDown={(e) => {
                    consumeBareArrows(e);
                }}
            >
                <PopoverTitle className="dk-label">{t("link.title")}</PopoverTitle>
                {open && <LinkPanel />}
            </PopoverContent>
        </Popover>
    );
}
