/**
 * Watch Together (WP16-34, port of tv-android `ui/together/WatchTogetherScreen.kt`).
 * Create a hub room → invite link + QR (web `/together?server=&inv=`), members with ready state, chat +
 * 5 reactions, leave. Join by code with the on-screen Keyboard. "Choose what to watch" goes Home; the
 * Player loads the file it starts into the room (player/useRoomSync.ts). Server < 3.5.0 has no `/hub`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { t } from "../i18n/messages";
import { mixaiOrigin } from "../lib/config";
import type { HubStatus, RoomChat, RoomReaction, RoomState } from "../lib/hub";
import type { ScreenProps } from "../nav/ctx";
import { useBackHandler } from "../nav/back";
import { useScreenActive } from "../nav/Nav";
import {
    Empty, ErrorState, Icon, Keyboard, LoadingBlock, PrimaryButton, ScreenHeader, SecondaryButton, useBackdrop, useFocusScope,
} from "../ui";
import { readDeviceName } from "./settings/device-name";
import "./settings/settings.css";

/** Reactions are content sent to other members (not UI icons), same set as tv-android. */
export const REACTIONS = ["\u{1F602}", "\u{1F62E}", "\u{1F44F}", "\u{1F525}", "\u2764\uFE0F"];
export const MIN_HUB_VERSION = "3.5.0";

export function versionLess(a: string, b: string): boolean {
    const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d < 0;
    }
    return false;
}

export function inviteLink(serverBaseUrl: string, invite: string): string {
    return `${mixaiOrigin()}/together?server=${encodeURIComponent(serverBaseUrl)}&inv=${encodeURIComponent(invite)}`;
}

interface Line { id: number; who: string; text: string; react: boolean }

function useHubStatus(ctx: ScreenProps<"together">["ctx"]): HubStatus {
    const [s, set] = useState<HubStatus>(ctx.hub.status);
    useEffect(() => { set(ctx.hub.status); return ctx.hub.statusChanged.on(set); }, [ctx.hub]);
    return s;
}

function StatusChip({ status }: { status: HubStatus }) {
    const tone = status === "connected" ? "badge-success" : status === "connecting" ? "badge-warning" : "badge-destructive";
    return <span className={`badge ${tone}`} data-testid="hub-status">{t(`tg.status.${status}`)}</span>;
}

function QrCanvas({ text }: { text: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (!ref.current) return;
        QRCode.toCanvas(ref.current, text, { width: 280, margin: 1 }).catch(() => undefined);
    }, [text]);
    return <canvas ref={ref} className="tg-qr" aria-label={t("tg.qr")} />;
}

function JoinDialog({ onJoin, onCancel, error }: { onJoin: (code: string) => void; onCancel: () => void; error: string | null }) {
    const ref = useRef<HTMLDivElement>(null);
    const [code, setCode] = useState("");
    useFocusScope(ref, true);
    useBackHandler(() => { onCancel(); }, true);
    const submit = () => { const c = code.trim().split(".")[0] ?? ""; if (c) onJoin(c); };
    return (
        <div className="overlay" role="presentation">
            <div ref={ref} className="dialog tg-join" role="dialog" aria-modal="true" aria-labelledby="tg-join-title" data-focus-scope="" data-testid="together-join">
                <h2 id="tg-join-title" className="dialog-title">{t("tg.joinTitle")}</h2>
                <div className="tg-code" aria-live="polite">{code || <span className="tg-dim">{t("tg.codeHint")}</span>}</div>
                {error && <div className="pin-error" role="alert">{error}</div>}
                <Keyboard value={code} onChange={setCode} onDone={submit} maxLength={64} id="tg-join" />
                <div className="dialog-actions" data-focus-row="tg-join-actions">
                    <SecondaryButton label={t("common.cancel")} onClick={onCancel} focusKey="tg:join-cancel" />
                    <PrimaryButton label={t("tg.join")} onClick={submit} focusKey="tg:join-ok" disabled={!code.trim()} />
                </div>
            </div>
        </div>
    );
}

export function Together({ ctx, params }: ScreenProps<"together">) {
    const hub = ctx.hub;
    const status = useHubStatus(ctx);
    const [room, setRoom] = useState<RoomState | null>(hub.room);
    const [version, setVersion] = useState<string | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const [joinOpen, setJoinOpen] = useState(false);
    const [lines, setLines] = useState<Line[]>([]);
    const [creating, setCreating] = useState(false);
    const lineId = useRef(0);
    // Text-heavy screen: no artwork behind it (cleared again each time it becomes the visible entry).
    const backdrop = useBackdrop();
    const screenActive = useScreenActive();
    useEffect(() => { if (screenActive) backdrop.clear(); }, [screenActive, backdrop]);

    useEffect(() => {
        let alive = true;
        fetch(`${ctx.cfg.baseUrl}/health`).then((r) => r.json() as Promise<{ version?: string }>)
            .then((j) => { if (alive) setVersion(j.version ?? null); })
            .catch(() => { if (alive) setVersion(null); });
        return () => { alive = false; };
    }, [ctx.cfg.baseUrl]);

    useEffect(() => {
        const add = (who: string, text: string, react: boolean) => {
            const id = ++lineId.current;
            setLines((l) => [...l.slice(-49), { id, who, text, react }]);
        };
        const offs = [
            hub.roomChanged.on((r) => { setRoom(r); if (r) { setCreating(false); setJoinOpen(false); setError(null); } }),
            hub.chat.on((c: RoomChat) => add(c.fromName, c.text, false)),
            hub.reactions.on((r: RoomReaction) => add(r.fromName, r.emoji, true)),
            hub.errors.on((e) => { setCreating(false); setError(errorText(e)); }),
        ];
        return () => offs.forEach((o) => o());
    }, [hub]);

    // Deep link / player button: join `params.roomId` once the socket is up.
    useEffect(() => {
        if (!params.roomId || status !== "connected" || hub.room?.roomId === params.roomId) return;
        hub.joinRoom(params.roomId);
    }, [params.roomId, status, hub]);

    const create = useCallback(() => {
        setError(null);
        setCreating(true);
        hub.createRoom(t("tg.roomName", { name: readDeviceName() }));
    }, [hub]);

    const tooOld = typeof version === "string" && versionLess(version, MIN_HUB_VERSION);
    const myId = hub.myConnId;
    const isHost = !!room && (!room.hostConnId || room.hostConnId === myId);

    return (
        <div className="tv-screen" data-scroll="screen" data-testid="screen-together">
            <ScreenHeader title={t("tg.title")} sub={t("tg.subtitle")} right={<StatusChip status={status} />} />
            {version === undefined && <LoadingBlock lines={3} />}
            {tooOld && <ErrorState title={t("tg.tooOldTitle")} message={t("tg.tooOld", { version: version ?? "?", min: MIN_HUB_VERSION })} />}
            {version !== undefined && !tooOld && !room && (
                <div className="tg-home">
                    {status !== "connected" && (
                        <div className="tg-note" role="status"><Icon name="alert" /> {status === "connecting" ? t("tg.connecting") : t("tg.offline")}</div>
                    )}
                    <Empty icon="group" title={t("tg.emptyTitle")} message={t("tg.emptyMsg")} />
                    <div className="tg-actions" data-focus-row="tg-home">
                        <PrimaryButton icon="plus" label={creating ? t("tg.creating") : t("tg.create")} onClick={create}
                            disabled={status !== "connected" || creating} focusKey="tg:create" testId="together-create" autoFocus />
                        <SecondaryButton icon="group" label={t("tg.join")} onClick={() => { setError(null); setJoinOpen(true); }}
                            disabled={status !== "connected"} focusKey="tg:join" testId="together-join-open" />
                    </div>
                    {error && <div className="pin-error" role="alert">{error}</div>}
                </div>
            )}
            {!tooOld && room && (
                <div className="tg-room" data-testid="together-room">
                    <section className="tg-col tg-col-main">
                        <h2 className="tg-h2">{room.name || t("tg.title")}</h2>
                        <div className="tg-meta">
                            {room.media?.title
                                ? t("tg.nowWatching", { title: room.media.title })
                                : t("tg.nothingYet")}
                            {" · "}{t(`tg.phase.${room.phase}`)}
                        </div>
                        <div className="tg-actions" data-focus-row="tg-room-actions">
                            <PrimaryButton icon="play" label={room.media ? t("tg.openPlayer") : t("tg.choose")}
                                onClick={() => ctx.nav.resetTo({ name: "home" })} focusKey="tg:choose" testId="together-choose" autoFocus />
                            <SecondaryButton icon="close" label={t("tg.leave")} onClick={() => hub.leave()} focusKey="tg:leave" testId="together-leave" />
                        </div>
                        <h3 className="tg-h3">{t("tg.members", { n: room.members.length })}</h3>
                        <ul className="tg-members">
                            {room.members.map((m) => (
                                <li key={m.connId} className="tg-member">
                                    <span className={`tg-dot${m.ready ? " is-ready" : ""}`} aria-hidden="true" />
                                    <span className="tg-member-name">{m.name || "?"}</span>
                                    <span className="tg-tags">
                                        {m.connId === room.hostConnId && <span className="badge badge-neutral">{t("tg.host")}</span>}
                                        {m.connId === myId && <span className="badge badge-neutral">{t("tg.you")}</span>}
                                        {m.guest && <span className="badge badge-neutral">{t("tg.guest")}</span>}
                                        <span className={`badge ${m.ready ? "badge-success" : "badge-warning"}`}>{m.ready ? t("tg.ready") : t("tg.notReady")}</span>
                                    </span>
                                </li>
                            ))}
                        </ul>
                        <h3 className="tg-h3">{t("tg.react")}</h3>
                        <div className="tg-reacts" data-focus-row="tg-reacts">
                            {REACTIONS.map((e, i) => (
                                <button key={e} type="button" className="tg-react" data-focusable="" data-focus-key={`tg:react:${i}`}
                                    aria-label={t("tg.sendReaction", { n: i + 1 })} onClick={() => hub.react(e, hub.roomExpectedPosition() ?? undefined)}>{e}</button>
                            ))}
                        </div>
                    </section>
                    <section className="tg-col">
                        <h3 className="tg-h3">{t("tg.invite")}</h3>
                        {room.invite && isHost ? (
                            <>
                                <QrCanvas text={inviteLink(ctx.cfg.baseUrl, room.invite)} />
                                <div className="tg-dim tg-small">{t("tg.inviteHint")}</div>
                            </>
                        ) : (
                            <div className="tg-dim tg-small">{t("tg.inviteCodeOnly")}</div>
                        )}
                        <div className="tg-codebox" data-testid="together-code">{room.roomId}</div>
                    </section>
                    <section className="tg-col">
                        <h3 className="tg-h3">{t("tg.chat")}</h3>
                        {lines.length === 0
                            ? <div className="tg-dim tg-small">{t("tg.chatEmpty")}</div>
                            : (
                                <ul className="tg-chat" aria-live="polite">
                                    {lines.slice(-14).map((l) => (
                                        <li key={l.id} className={l.react ? "is-react" : undefined}><b>{l.who || "?"}</b> {l.text}</li>
                                    ))}
                                </ul>
                            )}
                        <div className="tg-dim tg-small">{t("tg.chatHint")}</div>
                    </section>
                </div>
            )}
            {joinOpen && <JoinDialog error={error} onCancel={() => setJoinOpen(false)} onJoin={(c) => { setError(null); hub.joinRoom(c); }} />}
        </div>
    );
}

function errorText(code: string): string {
    switch (code) {
        case "room_not_found": return t("tg.err.notFound");
        case "room_full": return t("tg.err.full");
        case "not_in_room": return t("tg.err.notInRoom");
        default: return t("tg.err.other", { code });
    }
}
