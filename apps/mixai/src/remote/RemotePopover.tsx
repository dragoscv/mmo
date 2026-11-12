/**
 * Body of the connected-mode popover (opened from RemoteChip): start / stop, the controls lock,
 * the pairing codes, the party switch, the request queue with moderation, the connected devices.
 * At most 380 px wide and nothing scrolls: the three parts (codes, requests, devices) are tabs,
 * so the popover also fits the smallest window (600 px high), and long lists are paged.
 *
 * Keyboard: the tabs are a real tablist (one tab stop, arrows / Home / End move), the pager
 * turns with left / right, and no bare arrow leaves the popover (RemoteChip puts
 * `consumeBareArrows` on the popup): the app binds bare arrows to the crossfader. A control that
 * is unavailable keeps its focus (`soft`: aria-disabled, never native `disabled`), and when a
 * decision removes the focused button, focus goes to the same row's "Find in library".
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Lock, LockOpen } from "lucide-react";
import { useLocale, useT, type MessageKey } from "@/i18n";
import type { RemotePairing, RemoteRole, RequestDecision, RequestStatus, SongRequest } from "@/bridge/remote";
import { soft } from "@/components/deck-tabs/soft-disabled";
import { libraryNav } from "@/library/library-nav";
import { pluralCategory } from "@/library/track-view";
import { useShellPrefs } from "@/shell/shell-prefs";
import { countStatus, decisionsFor, errorDetail, errorKind, findQuery, focusRowAfter, hostOf, pageOf, pagerTarget, parseQrSvg, rovingTarget, type ErrorKind } from "./remote-core";
import { useRemoteStore } from "./remote-store";

const ROLE_KEY: Record<RemoteRole, MessageKey> = { controller: "remote.role.controller", viewer: "remote.role.viewer", guest: "remote.role.guest" };
const ROLE_HINT: Record<RemoteRole, MessageKey> = { controller: "remote.roleHint.controller", viewer: "remote.roleHint.viewer", guest: "remote.roleHint.guest" };
const STATUS_KEY: Record<RequestStatus, MessageKey> = { pending: "remote.status.pending", accepted: "remote.status.accepted", rejected: "remote.status.rejected", played: "remote.status.played" };
const DO_KEY: Record<RequestDecision, MessageKey> = { accepted: "remote.do.accepted", rejected: "remote.do.rejected", played: "remote.do.played" };
const ERROR_KEY: Record<ErrorKind, MessageKey> = {
    off: "remote.err.off",
    port: "remote.err.port",
    worker: "remote.err.worker",
    notFound: "remote.err.notFound",
    bind: "remote.err.bind",
    role: "remote.err.role",
    lock: "remote.err.lock",
    unknown: "remote.err.unknown",
};

/** Requests per page and devices listed (the popover never scrolls). Touch mode has 44 px buttons: one row less. */
const REQUESTS_PER_PAGE = 3;
const REQUESTS_PER_PAGE_TOUCH = 2;
const CLIENTS_SHOWN = 8;

type Tab = "codes" | "requests" | "clients";
const TABS: readonly Tab[] = ["codes", "requests", "clients"];

/** Focus was dropped (its element was removed or moved), not taken to another control. */
function focusLost(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || (a instanceof HTMLElement && a.dataset.slot === "popover-content");
}

/**
 * The QR code of a pairing URL. The shell sends it as an SVG string; it is parsed
 * (remote-core `parseQrSvg`: one path of unit squares, nothing else passes) and drawn here as
 * React elements, so no markup from outside is ever injected. Dark modules on a light plate in
 * every colour mode (remote.css): phone cameras read inverted codes badly.
 */
function Qr({ svg, label }: { svg: string; label: string }) {
    const t = useT();
    const qr = useMemo(() => parseQrSvg(svg), [svg]);
    if (!qr)
        return (
            <span className="rm-qr rm-qr-none" role="img" aria-label={label}>
                {t("remote.qrNone")}
            </span>
        );
    return (
        <svg className="rm-qr" role="img" aria-label={label} viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges">
            <path fill="currentColor" d={qr.d} />
        </svg>
    );
}

function Code({ pairing, zoomed, hint, onZoom }: { pairing: RemotePairing; zoomed: boolean; hint: boolean; onZoom: (role: RemoteRole | null) => void }) {
    const t = useT();
    const rotate = useRemoteStore((s) => s.rotate);
    const role = t(ROLE_KEY[pairing.role]);
    return (
        <li className="rm-code" data-role={pairing.role} data-zoomed={zoomed || undefined}>
            <span className="dk-label rm-code-role">{role}</span>
            <button type="button" className="rm-qr-btn" aria-pressed={zoomed} aria-label={t("remote.qrZoom", { role })} title={t("remote.qrZoom", { role })} onClick={() => onZoom(zoomed ? null : pairing.role)}>
                <Qr svg={pairing.qrSvg} label={t("remote.qrAria", { role })} />
            </button>
            {hint && <span className="rm-hint rm-code-hint">{t(ROLE_HINT[pairing.role])}</span>}
            <span className="dk-num dk-num-sm rm-url" title={zoomed ? undefined : pairing.url}>
                {pairing.url}
            </span>
            <span className="rm-code-actions">
                <button type="button" className="dk-btn dk-btn-xs" title={t("remote.newCodeTip", { role })} aria-label={t("remote.newCodeAria", { role })} onClick={() => void rotate(pairing.role)}>
                    {t("remote.newCode")}
                </button>
                {zoomed && (
                    <button type="button" className="dk-btn dk-btn-xs" onClick={() => onZoom(null)}>
                        {t("remote.qrBack")}
                    </button>
                )}
            </span>
        </li>
    );
}

/**
 * The pairing codes. Only the guest code shows when the tab opens: a DJ turns this screen to
 * the room, and the remote code is full deck control for anyone who photographs it. The other
 * two codes sit behind an explicit action, next to the warning.
 */
function Codes() {
    const t = useT();
    const pairings = useRemoteStore((s) => s.pairings);
    const [zoom, setZoom] = useState<RemoteRole | null>(null);
    const [showPrivate, setShowPrivate] = useState(false);
    const listRef = useRef<HTMLUListElement>(null);
    /** The code whose QR button takes the focus after "Back" removed the focused button. */
    const refocus = useRef<RemoteRole | null>(null);
    const visible = showPrivate ? pairings : pairings.filter((p) => p.role === "guest");
    const zoomed = zoom !== null && visible.some((p) => p.role === zoom) ? zoom : null;
    const shown = zoomed ? visible.filter((p) => p.role === zoomed) : visible;
    const layout = zoomed ? "one" : visible.length === 1 ? "solo" : "all";

    const onZoom = (role: RemoteRole | null) => {
        if (role === null) refocus.current = zoomed;
        setZoom(role);
    };
    useLayoutEffect(() => {
        const role = refocus.current;
        if (role === null || zoomed !== null) return;
        refocus.current = null;
        if (focusLost()) listRef.current?.querySelector<HTMLElement>(`[data-role="${role}"] .rm-qr-btn`)?.focus();
    });

    return (
        <>
            <ul ref={listRef} id="rm-code-list" className="rm-codes" data-layout={layout} aria-label={t("remote.codes")}>
                {shown.map((p) => (
                    <Code key={p.role} pairing={p} zoomed={zoomed === p.role} hint={layout !== "all"} onZoom={onZoom} />
                ))}
            </ul>
            {zoomed === null && (
                <>
                    <div className="rm-private">
                        <p className="rm-hint rm-warn">{t(showPrivate ? "remote.privateShown" : "remote.privateWarning")}</p>
                        {/* The same button in both states: it keeps the focus when the codes appear. */}
                        <button type="button" className="dk-btn dk-btn-xs" aria-expanded={showPrivate} aria-controls="rm-code-list" onClick={() => setShowPrivate(!showPrivate)}>
                            {showPrivate ? t("remote.hidePrivate") : t("remote.showPrivate")}
                        </button>
                    </div>
                    <p className="rm-hint">{t("remote.lanNote")}</p>
                </>
            )}
        </>
    );
}

function RequestRow({ request, index }: { request: SongRequest; index: number }) {
    const t = useT();
    const locale = useLocale();
    const decide = useRemoteStore((s) => s.decide);
    const song = request.artist ? `${request.title} · ${request.artist}` : request.title;
    return (
        <li className="rm-req" data-status={request.status} data-req={request.id} data-index={index}>
            <span className="rm-req-song" title={song}>
                <strong>{request.title}</strong>
                {request.artist && <span>· {request.artist}</span>}
            </span>
            <span className="dk-num dk-num-sm rm-req-votes">{t(`remote.votesN.${pluralCategory(request.votes, locale)}`, { n: request.votes })}</span>
            <span className="dk-label rm-req-status">{t(STATUS_KEY[request.status])}</span>
            {request.note && (
                <span className="rm-req-note" title={request.note}>
                    {t("remote.note", { note: request.note })}
                </span>
            )}
            <span className="rm-req-actions">
                {decisionsFor(request.status).map((d) => (
                    <button key={d} type="button" className="dk-btn dk-btn-xs" aria-label={t("remote.doAria", { action: t(DO_KEY[d]), song })} onClick={() => void decide(request.id, d)}>
                        {t(DO_KEY[d])}
                    </button>
                ))}
                {/* Always there, whatever the status: where the focus goes when a decision button leaves. */}
                <button type="button" className="dk-btn dk-btn-xs" data-find aria-label={t("remote.doAria", { action: t("remote.find"), song })} onClick={() => libraryNav.search(findQuery(request.title, request.artist))}>
                    {t("remote.find")}
                </button>
            </span>
        </li>
    );
}

function Requests() {
    const t = useT();
    const touch = useShellPrefs((s) => s.touch);
    const requests = useRemoteStore((s) => s.requests);
    const partyOpen = useRemoteStore((s) => s.partyOpen);
    const setPartyOpen = useRemoteStore((s) => s.setPartyOpen);
    const clearDone = useRemoteStore((s) => s.clearDone);
    const [page, setPage] = useState(0);
    const view = pageOf(requests, page, touch ? REQUESTS_PER_PAGE_TOUCH : REQUESTS_PER_PAGE);
    const pending = countStatus(requests, "pending");
    const accepted = countStatus(requests, "accepted");
    const done = requests.length - pending - accepted;

    const panelRef = useRef<HTMLElement>(null);
    const partyRef = useRef<HTMLButtonElement>(null);
    /**
     * Where the keyboard is in this panel: the request row (`id`, its place on the page), or a
     * control outside the rows (`id` null). Null = the focus is not in the panel. A decision
     * removes the focused button and the list re-sorts under it; this is what puts the focus
     * back on the same row (or the row that took its place) instead of dropping it.
     */
    const held = useRef<{ id: number | null; index: number } | null>(null);

    const onFocus = (e: FocusEvent<HTMLElement>) => {
        const row = e.target.closest<HTMLElement>("[data-req]");
        held.current = row ? { id: Number(row.dataset.req), index: Number(row.dataset.index) } : { id: null, index: 0 };
    };
    const onBlur = (e: FocusEvent<HTMLElement>) => {
        // The focus went to another control on purpose (a removed element names no target).
        if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) held.current = null;
    };
    // A click or a tap anywhere but on a button of this panel ends the keyboard position too.
    useEffect(() => {
        const onPointer = (e: PointerEvent) => {
            const target = e.target instanceof Element ? e.target.closest("button") : null;
            if (!target || !panelRef.current?.contains(target)) held.current = null;
        };
        document.addEventListener("pointerdown", onPointer, true);
        return () => document.removeEventListener("pointerdown", onPointer, true);
    }, []);
    // After every render: the focus was in this panel and has been dropped = put it back.
    useLayoutEffect(() => {
        const want = held.current;
        const panel = panelRef.current;
        if (!want || !panel || !focusLost()) return;
        const row = want.id === null ? null : focusRowAfter(want.id, view.items, want.index);
        const target = row === null ? null : panel.querySelector<HTMLElement>(`[data-index="${row}"] [data-find]`);
        // No row to go to (a pager button or the last request went away): the nearest fixed
        // control of the panel.
        (target ?? panel.querySelector<HTMLElement>("[data-fallback]") ?? partyRef.current)?.focus();
    });

    const onPagerKey = (e: KeyboardEvent<HTMLElement>) => {
        const next = pagerTarget(e, view.page, view.pages);
        if (next === null) return;
        // Left / right turn the page here; they must not reach the crossfader shortcut.
        e.preventDefault();
        e.stopPropagation();
        if (next !== view.page) setPage(next);
    };

    return (
        <section ref={panelRef} className="rm-panel" role="tabpanel" id="rm-panel-requests" aria-labelledby="rm-tab-requests" onFocus={onFocus} onBlur={onBlur}>
            <div className="rm-row rm-party">
                <button ref={partyRef} type="button" className="dk-btn" aria-pressed={partyOpen} onClick={() => void setPartyOpen(!partyOpen)}>
                    {t("remote.party")}
                </button>
                <span className="rm-hint">{partyOpen ? t("remote.partyOpen") : t("remote.partyClosed")}</span>
            </div>
            <span className="dk-num dk-num-sm rm-muted">{t("remote.requestsCount", { pending, accepted })}</span>
            {requests.length === 0 ? (
                <p className="rm-hint">{t("remote.requestsEmpty")}</p>
            ) : (
                <>
                    <ul className="rm-reqs">
                        {view.items.map((r, i) => (
                            <RequestRow key={r.id} request={r} index={i} />
                        ))}
                    </ul>
                    {/* Always there while there are requests: a button that removed itself would drop the focus. */}
                    <div className="rm-row">
                        {view.pages > 1 ? (
                            <span className="rm-pager" role="group" aria-label={t("remote.pagerAria")} onKeyDown={onPagerKey}>
                                <button type="button" className="dk-btn dk-btn-icon" aria-label={t("remote.prev")} title={t("remote.prev")} {...soft(view.page === 0, () => setPage(view.page - 1))}>
                                    <ChevronLeft size={14} aria-hidden />
                                </button>
                                <span className="dk-num dk-num-sm" aria-live="polite">
                                    {t("remote.page", { page: view.page + 1, pages: view.pages })}
                                </span>
                                <button type="button" className="dk-btn dk-btn-icon" aria-label={t("remote.next")} title={t("remote.next")} {...soft(view.page >= view.pages - 1, () => setPage(view.page + 1))}>
                                    <ChevronRight size={14} aria-hidden />
                                </button>
                            </span>
                        ) : (
                            <span />
                        )}
                        <button type="button" className="dk-btn dk-btn-xs" data-fallback {...soft(done === 0, () => void clearDone())}>
                            {t("remote.clearDone")}
                        </button>
                    </div>
                </>
            )}
        </section>
    );
}

function Clients() {
    const t = useT();
    const clients = useRemoteStore((s) => s.clients);
    const more = clients.length - CLIENTS_SHOWN;
    return (
        <section className="rm-panel" role="tabpanel" id="rm-panel-clients" aria-labelledby="rm-tab-clients">
            {clients.length === 0 ? (
                <p className="rm-hint">{t("remote.clientsNone")}</p>
            ) : (
                <ul className="rm-clients">
                    {clients.slice(0, CLIENTS_SHOWN).map((c) => (
                        <li key={`${c.id}@${c.addr}`}>
                            <span className="dk-label">{t(ROLE_KEY[c.role])}</span>
                            <span className="dk-num dk-num-sm rm-client-addr" title={c.id}>
                                {hostOf(c.addr)}
                            </span>
                        </li>
                    ))}
                    {more > 0 && <li className="rm-hint">{t("remote.clientsMore", { n: more })}</li>}
                </ul>
            )}
        </section>
    );
}

/**
 * "Lock phones": while on, the shell refuses every transport and mixer command from a phone
 * (a remote in a pocket cannot pause a deck or pull the master down); requests keep working.
 * The state is the button's pressed state, its icon and the sentence next to it.
 */
function LockRow() {
    const t = useT();
    const locked = useRemoteStore((s) => s.controlsLocked);
    const setLocked = useRemoteStore((s) => s.setControlsLocked);
    return (
        <div className="rm-row rm-lock">
            <button type="button" className="dk-btn" aria-pressed={locked} onClick={() => void setLocked(!locked)}>
                {locked ? <Lock size={12} aria-hidden /> : <LockOpen size={12} aria-hidden />}
                {t("remote.lock")}
            </button>
            <span className="rm-hint">{locked ? t("remote.lockOn") : t("remote.lockOff")}</span>
        </div>
    );
}

/** The running server: the lock and three tabs, opened on the requests when some are waiting. */
function Running() {
    const t = useT();
    const clients = useRemoteStore((s) => s.clients.length);
    const pending = useRemoteStore((s) => countStatus(s.requests, "pending"));
    const [tab, setTab] = useState<Tab>(() => (countStatus(useRemoteStore.getState().requests, "pending") > 0 ? "requests" : "codes"));
    const name: Record<Tab, string> = { codes: t("remote.tab.codes"), requests: t("remote.requests"), clients: t("remote.clients") };
    const count: Record<Tab, number | null> = { codes: null, requests: pending, clients };

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

    return (
        <>
            <LockRow />
            <div className="rm-tabs" role="tablist" aria-label={t("remote.tabs")} aria-orientation="horizontal" onKeyDown={onTabsKey}>
                {TABS.map((id) => (
                    <button key={id} id={`rm-tab-${id}`} type="button" role="tab" className="dk-tab" aria-selected={tab === id} aria-controls={tab === id ? `rm-panel-${id}` : undefined} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}>
                        {name[id]}
                        {count[id] !== null && (
                            <span className="dk-num dk-num-sm" data-alert={id === "requests" && pending > 0 ? "true" : undefined}>
                                {count[id]}
                            </span>
                        )}
                    </button>
                ))}
            </div>
            {tab === "codes" && (
                <section className="rm-panel" role="tabpanel" id="rm-panel-codes" aria-labelledby="rm-tab-codes">
                    <Codes />
                </section>
            )}
            {tab === "requests" && <Requests />}
            {tab === "clients" && <Clients />}
        </>
    );
}

/**
 * A refused action, in the UI language: the cases the shell is known to report each have their
 * own sentence; anything else gets a generic sentence and the shell's own (English) text as
 * code, never spliced into a translated sentence.
 */
function ErrorNote({ error }: { error: string }) {
    const t = useT();
    const kind = errorKind(error);
    const raw = kind === "unknown" ? error : kind === "port" || kind === "worker" ? errorDetail(error) : null;
    return (
        <p className="rm-error" role="alert">
            {t(ERROR_KEY[kind])}
            {raw && (
                <>
                    {" "}
                    <code className="rm-error-raw" lang="en">
                        {raw}
                    </code>
                </>
            )}
        </p>
    );
}

export function RemotePopover() {
    const t = useT();
    const availability = useRemoteStore((s) => s.availability);
    const running = useRemoteStore((s) => s.running);
    const busy = useRemoteStore((s) => s.busy);
    const error = useRemoteStore((s) => s.error);
    const host = useRemoteStore((s) => s.host);
    const port = useRemoteStore((s) => s.port);
    const start = useRemoteStore((s) => s.start);
    const stop = useRemoteStore((s) => s.stop);
    const unavailable = availability === "preview" || availability === "old";
    return (
        <div className="rm-body">
            <div className="rm-row">
                <span className="dk-num dk-num-sm rm-state" role="status">
                    {unavailable ? t("remote.stateNa") : running ? t("remote.stateOn", { host: host ?? "", port: port ?? "" }) : busy ? t("remote.starting") : t("remote.stateOff")}
                </span>
                {/* Never natively disabled: it is the focused button while its own action runs. */}
                <button type="button" className="dk-btn" aria-pressed={running} {...soft(unavailable || busy, () => void (running ? stop() : start()))}>
                    {running ? t("remote.stop") : t("remote.start")}
                </button>
            </div>
            {error && <ErrorNote error={error} />}
            {unavailable ? (
                <p className="rm-hint">{t(availability === "old" ? "remote.na.old" : "remote.na.preview")}</p>
            ) : !running ? (
                <p className="rm-hint">{t("remote.intro")}</p>
            ) : (
                <Running />
            )}
        </div>
    );
}
