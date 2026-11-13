/**
 * Body of the gig popover (opened from GigChip or the command palette). Three tabs, so it fits
 * the 600 px minimum window without scrolling, in touch mode too:
 *
 *   Lock       the switch, the two-step unlock, what the lock covers, keep-awake, and which
 *              checks are not ok (locking is allowed anyway).
 *   Checklist  "Run checks" (+ the 10 s dropout measurement with progress and Cancel) and one
 *              row per check: state by icon AND word, one sentence, the time that result was
 *              taken, and what to do for a warning or a problem.
 *   Held       what the lock held back: the counters and the texts of the last few hidden
 *              notifications, with their time. Readable while locked and after the unlock,
 *              until the next lock.
 *
 * Unlock is two steps on two controls: "Unlock" arms (the same button then reads "Keep
 * locked", so the focus rests on the safe choice), "Confirm unlock" next to it unlocks within
 * 5 seconds. The rule is in gig-core (`confirmUnlock`) and is checked again at the second step.
 * A Confirm that does not unlock says why (no first step, too soon, too late).
 *
 * No control is switched off with the native `disabled` (the focus would fall to <body>):
 * unavailable buttons are `aria-disabled`. Bare arrows are consumed by the popup (GigChip),
 * the tab row uses them itself.
 *
 * Screen readers hear what starts and what ends, never a count: arming the unlock and its
 * result, the start of the dropout measurement and its result. The seconds that tick on
 * screen are not in a live region.
 *
 * Opening the popover asks the one-shot checks once; closing it cancels a running
 * measurement. Nothing here runs on a timer except the countdown of that measurement.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, CircleQuestionMark, OctagonX, TriangleAlert } from "lucide-react";
import { platform } from "@/bridge/window";
import { useLocale, useT, type MessageKey } from "@/i18n";
import { pluralCategory } from "@/library/track-view";
import { rovingTarget } from "@/remote/remote-core";
import { clockOf } from "./GigChip";
import { useGigChecks } from "./gig-checks";
import { CHECK_IDS, formatBytes, formatDecimal, minutesText, notOk, type CheckId, type CheckResult, type CheckState, type ShellLink, type Vars } from "./gig-core";
import { useGigStore } from "./gig-store";

type Tab = "lock" | "checks" | "held";
const TABS: readonly Tab[] = ["lock", "checks", "held"];

const COVERS: readonly MessageKey[] = ["gig.covers.settings", "gig.covers.cloud", "gig.covers.layout", "gig.covers.toasts", "gig.covers.close", "gig.covers.awake"];
const AWAKE_KEY: Record<ShellLink, MessageKey> = {
    on: "gig.awake.on",
    off: "gig.awake.off",
    unsupported: "gig.awake.unsupported",
    failed: "gig.awake.failed",
    na: "gig.awake.na",
    pending: "gig.awake.pending",
    unconfirmed: "gig.awake.unconfirmed",
};
const STATE_KEY: Record<CheckState, MessageKey> = { ok: "gig.state.ok", warn: "gig.state.warn", problem: "gig.state.problem", unknown: "gig.state.unknown" };
const CHECK_KEY: Record<CheckId, MessageKey> = {
    audio: "gig.check.audio",
    power: "gig.check.power",
    disk: "gig.check.disk",
    dropouts: "gig.check.dropouts",
    library: "gig.check.library",
    controller: "gig.check.controller",
};
/** Why a Confirm did not unlock, as the hint under the buttons says it. */
const REFUSAL_KEY: Record<"early" | "late" | "none", MessageKey> = { early: "gig.confirmEarly", late: "gig.confirmLate", none: "gig.unlockHint" };

const timeOf = (at: number, locale: string) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function StateIcon({ state }: { state: CheckState }): ReactNode {
    const p = { size: 12, "aria-hidden": true } as const;
    return state === "ok" ? <Check {...p} /> : state === "warn" ? <TriangleAlert {...p} /> : state === "problem" ? <OctagonX {...p} /> : <CircleQuestionMark {...p} />;
}

/** The two-step unlock and the switch. */
function LockControls({ onUnlocked }: { onUnlocked: () => void }) {
    const t = useT();
    const locale = useLocale();
    const locked = useGigStore((s) => s.locked);
    const since = useGigStore((s) => s.since);
    const armed = useGigStore((s) => s.armed !== null);
    // Why the last Confirm did not unlock; `n` makes the same reason a new announcement.
    const [refused, setRefused] = useState<{ why: "early" | "late" | "none"; n: number } | null>(null);
    const main = useRef<HTMLButtonElement>(null);
    // A new first step (or its end) starts the hint over.
    useEffect(() => setRefused(null), [armed, locked]);
    const onMain = () => {
        const s = useGigStore.getState();
        if (!s.locked) s.lock();
        else if (s.armed !== null) s.cancelUnlock();
        else s.requestUnlock();
    };
    const onConfirm = () => {
        const s = useGigStore.getState();
        const why = s.confirmRefusal();
        if (why !== null) {
            // Not silently: the hint (a status region) says what is missing.
            setRefused((r) => ({ why, n: (r?.n ?? 0) + 1 }));
            return;
        }
        if (!s.confirmUnlock()) return;
        // "Confirm" goes away with the lock: the focus moves to the switch, not to <body>.
        main.current?.focus();
        onUnlocked();
    };
    return (
        <div className="gg-switch">
            <p className="gg-state" data-on={locked}>
                <i className="sb-dot" data-state={locked ? "online" : "offline"} />
                <span>{locked ? t("gig.lockedSince", { since: clockOf(since, locale) }) : t("gig.offLong")}</span>
            </p>
            <div className="gg-actions">
                <button ref={main} type="button" className="dk-btn" data-gig-main="" onClick={onMain}>
                    {!locked ? t("gig.lock") : armed ? t("gig.cancel") : t("gig.unlock")}
                </button>
                {locked && (
                    <button type="button" className="dk-btn gg-confirm" data-gig-confirm="" aria-describedby="gg-armed-hint" aria-disabled={!armed || undefined} onClick={onConfirm}>
                        {t("gig.confirm")}
                    </button>
                )}
            </div>
            {locked && (
                <p id="gg-armed-hint" className="gg-hint" role="status" data-gig-refused={refused?.why}>
                    <span key={refused ? `r${refused.n}` : armed ? "armed" : "idle"}>{refused ? t(REFUSAL_KEY[refused.why]) : armed ? t("gig.armedHint") : t("gig.unlockHint")}</span>
                </p>
            )}
        </div>
    );
}

function LockTab() {
    const t = useT();
    const locked = useGigStore((s) => s.locked);
    const awake = useGigStore((s) => s.awake);
    const results = useGigChecks((s) => s.results);
    const bad = notOk(results);
    const [, bump] = useState(0);
    // While unlocked the line says "off", except when the app can never keep awake here.
    const awakeShown: ShellLink = locked ? awake : awake === "na" || awake === "unsupported" ? awake : "off";
    return (
        <>
            <LockControls onUnlocked={() => bump((n) => n + 1)} />
            {bad.length > 0 && (
                <p className="gg-warn" data-gig-notok="">
                    <TriangleAlert size={12} aria-hidden />
                    <span>{t(locked ? "gig.notOkLocked" : "gig.notOk", { list: bad.map((id) => t(CHECK_KEY[id])).join(", ") })}</span>
                </p>
            )}
            <section className="gg-sec" aria-label={t("gig.coversTitle")}>
                <span className="dk-label">{t("gig.coversTitle")}</span>
                <ul className="gg-list">
                    {COVERS.map((k) => (
                        <li key={k}>{t(k)}</li>
                    ))}
                </ul>
                <p className="gg-hint">{t("gig.notCovers")}</p>
                {/* macOS only: the system's own Quit never reaches the app's question. */}
                {platform() === "macos" && (
                    <p className="gg-hint" data-gig-mac="">
                        {t("gig.macQuit")}
                    </p>
                )}
            </section>
            <p className="gg-awake">
                <span className="dk-label">{t("gig.awake")}</span>
                <span data-gig-awake={locked ? awake : "off"}>{t(AWAKE_KEY[awakeShown])}</span>
            </p>
        </>
    );
}

/** The sentence of a result: numbers are written here, in the language of the UI (bytes, recording time, decimals, error codes). */
function sentence(t: ReturnType<typeof useT>, locale: string, r: CheckResult): string {
    const vars: Vars = { ...r.vars };
    if (typeof vars.free === "number") vars.free = formatBytes(vars.free, locale);
    if (typeof vars.minutes === "number") vars.time = minutesText(vars.minutes);
    if (typeof vars.khz === "number") vars.khz = formatDecimal(vars.khz, locale);
    if (typeof vars.ms === "number") vars.ms = formatDecimal(vars.ms, locale);
    if (typeof vars.code === "string") vars.code = t(`gig.diskErr.${vars.code}` as MessageKey);
    return t(`gig.r.${r.reason}` as MessageKey, vars);
}

function Row({ id }: { id: CheckId }) {
    const t = useT();
    const locale = useLocale();
    const r = useGigChecks((s) => s.results[id]) ?? (id === "dropouts" ? ({ state: "unknown", reason: "dropouts.notRun", vars: {} } as CheckResult) : null);
    const at = useGigChecks((s) => s.at[id]);
    const state: CheckState = r?.state ?? "unknown";
    return (
        <li className="gg-row" data-state={state} data-gig-check={id} data-reason={r?.reason ?? ""}>
            <span className="gg-row-state">
                <StateIcon state={state} />
                <strong className="dk-label">{t(STATE_KEY[state])}</strong>
            </span>
            <span className="gg-row-body">
                <span className="dk-label gg-row-name">{t(CHECK_KEY[id])}</span>
                {/* Each row says when ITS result was taken: an older dropout measurement does not look new after a refresh. */}
                {at !== undefined && (
                    <time className="gg-row-at" dateTime={new Date(at).toISOString()} data-gig-at={at}>
                        {t("gig.rowAt", { time: timeOf(at, locale) })}
                    </time>
                )}
                <span className="gg-row-text">{r ? sentence(t, locale, r) : t("gig.checking")}</span>
                {r && (state === "warn" || state === "problem") && <span className="gg-row-fix">{t(`gig.fix.${r.reason}` as MessageKey)}</span>}
            </span>
        </li>
    );
}

function ChecksTab() {
    const t = useT();
    const locale = useLocale();
    const secondsLeft = useGigChecks((s) => s.secondsLeft);
    const takenAt = useGigChecks((s) => s.takenAt);
    const measuring = secondsLeft > 0;
    const onRun = () => {
        const c = useGigChecks.getState();
        if (c.secondsLeft > 0) c.cancel();
        else void c.run();
    };
    const done = takenAt ? t("gig.takenAt", { time: timeOf(takenAt, locale) }) : t("gig.notRun");
    return (
        <>
            <div className="gg-run">
                <button type="button" className="dk-btn" data-gig-run="" onClick={onRun}>
                    {measuring ? t("gig.cancelRun") : t("gig.run")}
                </button>
                <span className="gg-hint gg-run-note">
                    {/* The seconds tick on screen only; screen readers hear the start and the result (below). */}
                    <span data-gig-progress="" aria-hidden={measuring || undefined}>
                        {measuring ? t("gig.running", { s: secondsLeft }) : done}
                    </span>
                    <span className="sr-only" role="status" data-gig-run-status="">
                        {measuring ? t("gig.runningStart") : done}
                    </span>
                </span>
            </div>
            <ul className="gg-rows" aria-label={t("gig.checksTitle")}>
                {CHECK_IDS.map((id) => (
                    <Row key={id} id={id} />
                ))}
            </ul>
        </>
    );
}

/** What the lock held back: the counters, and the last hidden notifications with their time. Kept after the unlock, until the next lock. */
function HeldTab() {
    const t = useT();
    const locale = useLocale();
    const locked = useGigStore((s) => s.locked);
    const skipped = useGigStore((s) => s.skipped);
    const hidden = useGigStore((s) => s.hidden);
    const lines: string[] = [];
    if (skipped.toasts > 0) lines.push(t(`gig.held.toasts.${pluralCategory(skipped.toasts, locale)}`, { n: skipped.toasts }));
    if (skipped.layouts > 0) lines.push(t(`gig.held.layouts.${pluralCategory(skipped.layouts, locale)}`, { n: skipped.layouts }));
    if (skipped.cloudPull || skipped.cloudPush) lines.push(t("gig.held.cloud"));
    return (
        <>
            <section className="gg-held" aria-label={t("gig.heldTitle")}>
                <span className="dk-label">{t("gig.heldTitle")}</span>
                {lines.length === 0 ? (
                    <p className="gg-hint">{t("gig.held.none")}</p>
                ) : (
                    <ul className="gg-list" data-gig-held="">
                        {lines.map((l) => (
                            <li key={l}>{l}</li>
                        ))}
                    </ul>
                )}
                {!locked && (lines.length > 0 || hidden.length > 0) && <p className="gg-hint">{t("gig.heldKept")}</p>}
            </section>
            <section className="gg-sec" aria-label={t("gig.hiddenTitle")}>
                <span className="dk-label">{t("gig.hiddenTitle")}</span>
                {hidden.length === 0 ? (
                    <p className="gg-hint">{t("gig.hiddenNone")}</p>
                ) : (
                    // Newest first: the one the DJ most likely wants to see.
                    <ul className="gg-list gg-hidden" data-gig-hidden="">
                        {[...hidden].reverse().map((h, i) => (
                            <li key={`${h.at}-${i}`}>
                                <time className="gg-row-at" dateTime={new Date(h.at).toISOString()}>
                                    {timeOf(h.at, locale)}
                                </time>
                                <span className="gg-hidden-text">{h.text}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </>
    );
}

export function GigPopover() {
    const t = useT();
    const [tab, setTab] = useState<Tab>("lock");
    const heldCount = useGigStore((s) => s.skipped.toasts + s.skipped.layouts + (s.skipped.cloudPull || s.skipped.cloudPush ? 1 : 0));
    // One round of one-shot questions when the popover opens; a running measurement ends with it.
    useEffect(() => {
        void useGigChecks.getState().refresh();
        return () => {
            useGigChecks.getState().cancel();
            useGigStore.getState().cancelUnlock();
        };
    }, []);
    // A real tablist: one tab stop, arrows / Home / End move and select. The key is used up
    // here, so a bare arrow on a tab never becomes "crossfader hard to A / B".
    const onTabsKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const next = rovingTarget(e, TABS.indexOf(tab), TABS.length);
        if (next === null) return;
        e.preventDefault();
        e.stopPropagation();
        const id = TABS[next];
        if (!id) return;
        setTab(id);
        e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    };
    const name: Record<Tab, string> = { lock: t("gig.tab.lock"), checks: t("gig.tab.checks"), held: heldCount > 0 ? t("gig.tab.heldN", { n: heldCount }) : t("gig.tab.held") };
    return (
        <div className="gg-body">
            <div className="gg-tabs" role="tablist" aria-label={t("gig.tabs")} aria-orientation="horizontal" onKeyDown={onTabsKey}>
                {TABS.map((id) => (
                    <button key={id} id={`gg-tab-${id}`} type="button" role="tab" className="dk-tab" aria-selected={tab === id} aria-controls={tab === id ? `gg-panel-${id}` : undefined} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
                        {name[id]}
                    </button>
                ))}
            </div>
            <section className="gg-panel" role="tabpanel" id={`gg-panel-${tab}`} aria-labelledby={`gg-tab-${tab}`}>
                {tab === "lock" ? <LockTab /> : tab === "checks" ? <ChecksTab /> : <HeldTab />}
            </section>
        </div>
    );
}
