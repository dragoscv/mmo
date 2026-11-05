"use client";

/**
 * Watch Together panel (WP16-39, port of tv-tizen `screens/Together.tsx` + the player side panel).
 * Owner: create a room → invite link (copy / share; the TVs show the same link as a QR code), members with
 * ready state, chat, reactions, leave. Guests (`/together`) get the same chat + reactions, no create/invite.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Copy, Crown, LogOut, Send, Share2, Users } from "lucide-react";
import type { HubClient, HubStatus, RoomChat, RoomReaction, RoomState } from "@/lib/mmo/hub";
import { inviteLink, REACTIONS } from "./model";

export interface ChatLine { id: number; who: string; text: string; react: boolean; mine: boolean }

/** Room chat + reactions as a rolling list (last 50), plus the hub status. */
export function useRoomChat(hub: HubClient | null): { lines: ChatLine[]; status: HubStatus; room: RoomState | null } {
    const [lines, setLines] = useState<ChatLine[]>([]);
    const [status, setStatus] = useState<HubStatus>(() => hub?.status ?? "disconnected");
    const [room, setRoom] = useState<RoomState | null>(() => hub?.room ?? null);
    const id = useRef(0);
    useEffect(() => {
        if (!hub) return;
        const add = (who: string, text: string, react: boolean, conn: string | null) => {
            const n = ++id.current;
            setLines((l) => [...l.slice(-49), { id: n, who, text, react, mine: !!conn && conn === hub.myConnId }]);
        };
        const offs = [
            hub.chat.on((c: RoomChat) => add(c.fromName, c.text, false, c.fromConnId)),
            hub.reactions.on((r: RoomReaction) => add(r.fromName, r.emoji, true, null)),
            hub.statusChanged.on(setStatus),
            hub.roomChanged.on(setRoom),
        ];
        const sync = window.setTimeout(() => { setStatus(hub.status); setRoom(hub.room); }, 0);
        return () => { offs.forEach((o) => o()); window.clearTimeout(sync); };
    }, [hub]);
    return { lines, status, room };
}

export interface TogetherPanelProps {
    hub: HubClient;
    room: RoomState | null;
    status: HubStatus;
    lines: ChatLine[];
    /** Owner can create rooms + share invites; guests cannot. */
    canCreate: boolean;
    /** MMO Server base URL encoded into the invite link. */
    serverBaseUrl: string;
    /** Current media position for reactions. */
    mediaSec(): number;
    notify(msg: string): void;
}

export function TogetherPanel({ hub, room, status, lines, canCreate, serverBaseUrl, mediaSec, notify }: TogetherPanelProps) {
    const t = useTranslations("mx.player.together");
    const [text, setText] = useState("");
    const [creating, setCreating] = useState(false);
    const logRef = useRef<HTMLOListElement>(null);
    const [origin, setOrigin] = useState("");
    useEffect(() => { const h = window.setTimeout(() => setOrigin(window.location.origin), 0); return () => window.clearTimeout(h); }, []);

    useEffect(() => {
        const el = logRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [lines.length]);
    useEffect(() => {
        if (!room) return;
        const h = window.setTimeout(() => setCreating(false), 0);
        return () => window.clearTimeout(h);
    }, [room]);

    const link = room?.invite && origin ? inviteLink(origin, serverBaseUrl, room.invite) : null;

    const create = () => {
        if (status !== "connected") { notify(t("offline")); return; }
        setCreating(true);
        hub.createRoom();
        window.setTimeout(() => setCreating(false), 8000);
    };
    const copy = async () => {
        if (!link) return;
        try { await navigator.clipboard.writeText(link); notify(t("copied")); } catch { notify(t("copyFailed")); }
    };
    const share = async () => {
        if (!link || typeof navigator.share !== "function") return;
        try { await navigator.share({ title: t("shareTitle"), url: link }); } catch { /* cancelled */ }
    };
    const send = (e: FormEvent) => {
        e.preventDefault();
        const v = text.trim();
        if (!v) return;
        hub.sendChat(v.slice(0, 500));
        setText("");
    };

    if (!room) {
        return (
            <div className="mxp-together">
                <p className="mxp-muted">{canCreate ? t("intro") : t("guestNoRoom")}</p>
                {status !== "connected" && <p className="mxp-warn" role="status">{status === "connecting" ? t("connecting") : t("offline")}</p>}
                {canCreate && (
                    <button type="button" className="mxp-btn mxp-btn-primary" onClick={create} disabled={creating || status !== "connected"} aria-busy={creating || undefined}>
                        <Users aria-hidden className="size-4" />{creating ? t("creating") : t("create")}
                    </button>
                )}
            </div>
        );
    }

    const host = room.hostConnId;
    return (
        <div className="mxp-together">
            {canCreate && link && (
                <section className="mxp-section" aria-labelledby="mxp-tg-invite">
                    <h3 id="mxp-tg-invite" className="mxp-section-title">{t("invite")}</h3>
                    <p className="mxp-muted">{t("inviteHint")}</p>
                    <div className="mxp-invite">
                        <input className="mxp-input" readOnly value={link} aria-label={t("inviteLink")} onFocus={(e) => e.currentTarget.select()} />
                        <button type="button" className="mxp-icon-btn" onClick={() => { void copy(); }} aria-label={t("copy")}>
                            <Copy aria-hidden className="size-4" />
                        </button>
                        {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
                            <button type="button" className="mxp-icon-btn" onClick={() => { void share(); }} aria-label={t("share")}>
                                <Share2 aria-hidden className="size-4" />
                            </button>
                        )}
                    </div>
                </section>
            )}

            <section className="mxp-section" aria-labelledby="mxp-tg-members">
                <h3 id="mxp-tg-members" className="mxp-section-title">{t("members", { count: room.members.length })}</h3>
                {room.phase === "waiting" && <p className="mxp-muted" role="status">{t("waiting")}</p>}
                <ul className="mxp-members">
                    {room.members.map((m) => (
                        <li key={m.connId} className="mxp-member">
                            <span className="mxp-dot" data-ready={m.ready || undefined} aria-hidden />
                            <span className="mxp-member-name">{m.name || t("guest")}</span>
                            {m.connId === hub.myConnId && <span className="mxp-chip">{t("you")}</span>}
                            {m.connId === host && <span className="mxp-chip"><Crown aria-hidden className="size-3" />{t("host")}</span>}
                            <span className="sr-only">{m.ready ? t("ready") : t("notReady")}</span>
                        </li>
                    ))}
                </ul>
            </section>

            <section className="mxp-section mxp-chat" aria-labelledby="mxp-tg-chat">
                <h3 id="mxp-tg-chat" className="mxp-section-title">{t("chat")}</h3>
                <div className="mxp-reactions" role="group" aria-label={t("reactions")}>
                    {REACTIONS.map((r) => (
                        <button key={r} type="button" className="mxp-react" onClick={() => hub.react(r, mediaSec())} aria-label={t("react", { emoji: r })}>
                            <span aria-hidden>{r}</span>
                        </button>
                    ))}
                </div>
                <ol ref={logRef} className="mxp-chat-log" aria-live="polite" aria-label={t("chatLog")}>
                    {lines.length === 0 && <li className="mxp-muted">{t("chatEmpty")}</li>}
                    {lines.map((l) => (
                        <li key={l.id} className="mxp-chat-line" data-react={l.react || undefined} data-mine={l.mine || undefined}>
                            <span className="mxp-chat-who">{l.who || t("guest")}</span>
                            <span className="mxp-chat-text">{l.text}</span>
                        </li>
                    ))}
                </ol>
                <form className="mxp-chat-form" onSubmit={send}>
                    <input className="mxp-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={500}
                        placeholder={t("chatPlaceholder")} aria-label={t("chatPlaceholder")} />
                    <button type="submit" className="mxp-icon-btn" aria-label={t("send")} disabled={!text.trim()}>
                        <Send aria-hidden className="size-4" />
                    </button>
                </form>
            </section>

            <button type="button" className="mxp-btn mxp-btn-ghost" onClick={() => hub.leave()}>
                <LogOut aria-hidden className="size-4" />{t("leave")}
            </button>
        </div>
    );
}

/** Server `error` codes → message keys. */
export function roomErrorKey(code: string): "errNotFound" | "errFull" | "errNotInRoom" | "errGeneric" {
    if (code === "room_not_found") return "errNotFound";
    if (code === "room_full") return "errFull";
    if (code === "not_in_room") return "errNotInRoom";
    return "errGeneric";
}
