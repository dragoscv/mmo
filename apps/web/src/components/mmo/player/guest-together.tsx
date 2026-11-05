"use client";

/**
 * Public Watch Together guest page (`/together?server=&inv=`, WP16-39). Opened from the TV QR codes and the
 * web invite link; no MixAI account and no MmoProvider. Flow: validate `server` → ask a display name
 * (localStorage) → `GET {server}/hub/invite/{inv}` (public) → guest hub socket (`?inv=&name=`) → play the
 * room's media with `?inv=` (server.ts maps a valid invite to the room's current file only) and follow the room.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Clapperboard, Loader2, Users } from "lucide-react";
import { HubClient } from "@/lib/mmo/hub";
import type { HubMedia, HubRoomPhase } from "@/lib/mmo/media-types";
import { tmdbImg } from "@/lib/media/normalize";
import { CinemaPlayer } from "./cinema-player";
import { DEFAULT_PREFS, inviteExpiry, parseServerUrl, type StreamAuth } from "./model";
import { roomErrorKey, TogetherPanel, useRoomChat } from "./together-panel";
import "./player.css";

export const GUEST_NAME_KEY = "mixai-web:guest-name";
const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0";

interface InviteInfo { roomId: string; name: string; phase: HubRoomPhase; media: HubMedia | null; members: number }

type Load =
    | { s: "loading" }
    | { s: "ok"; info: InviteInfo }
    | { s: "invalid" }
    | { s: "unreachable" };

export function GuestTogether({ server: rawServer, invite }: { server: string | null; invite: string | null }) {
    const t = useTranslations("mx.player.guest");
    const server = useMemo(() => parseServerUrl(rawServer), [rawServer]);
    const inv = invite?.trim() || null;
    const [expired, setExpired] = useState(false);
    useEffect(() => {
        const exp = inv ? inviteExpiry(inv) : null;
        const h = window.setTimeout(() => setExpired(exp !== null && exp < Date.now()), 0);
        return () => window.clearTimeout(h);
    }, [inv]);
    const [name, setName] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [load, setLoad] = useState<Load>({ s: "loading" });
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const h = window.setTimeout(() => {
            try { setDraft(localStorage.getItem(GUEST_NAME_KEY) ?? ""); } catch { /* storage off */ }
        }, 0);
        return () => window.clearTimeout(h);
    }, []);

    useEffect(() => {
        if (!server || !inv || expired) return;
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), 10_000);
        fetch(`${server}/hub/invite/${encodeURIComponent(inv)}`, { signal: ctrl.signal, cache: "no-store" })
            .then(async (r) => {
                if (r.status === 404 || r.status === 400) { setLoad({ s: "invalid" }); return; }
                if (!r.ok) { setLoad({ s: "unreachable" }); return; }
                const j = (await r.json()) as InviteInfo;
                setLoad({ s: "ok", info: j });
            })
            .catch(() => { if (!ctrl.signal.aborted || load.s === "loading") setLoad({ s: "unreachable" }); })
            .finally(() => window.clearTimeout(timer));
        return () => { ctrl.abort(); window.clearTimeout(timer); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [server, inv, expired, attempt]);

    if (!server || !inv) return <GuestMessage title={t("badLinkTitle")} body={t("badLinkBody")} />;
    if (expired) return <GuestMessage title={t("expiredTitle")} body={t("expiredBody")} />;
    if (load.s === "invalid") return <GuestMessage title={t("expiredTitle")} body={t("invalidBody")} />;
    if (load.s === "unreachable") {
        return <GuestMessage title={t("unreachableTitle")} body={t("unreachableBody")} action={{ label: t("retry"), run: () => { setLoad({ s: "loading" }); setAttempt((a) => a + 1); } }} />;
    }

    const submit = (e: FormEvent) => {
        e.preventDefault();
        const v = draft.trim().slice(0, 32);
        if (!v) return;
        try { localStorage.setItem(GUEST_NAME_KEY, v); } catch { /* storage off */ }
        setName(v);
    };

    if (!name) {
        const info = load.s === "ok" ? load.info : null;
        return (
            <main className="mxg-page">
                <section className="mxg-card" aria-labelledby="mxg-title">
                    <Clapperboard aria-hidden className="mxg-logo size-8" />
                    <h1 id="mxg-title" className="mxg-title">{t("joinTitle")}</h1>
                    {load.s === "loading" && <p className="mxp-muted" role="status"><Loader2 aria-hidden className="mxp-spin size-4" /> {t("loading")}</p>}
                    {info && (
                        <div className="mxg-room">
                            {info.media?.posterPath && (
                                // eslint-disable-next-line @next/next/no-img-element -- public TMDB poster
                                <img src={tmdbImg(info.media.posterPath, "w185") ?? undefined} alt="" className="mxg-poster" />
                            )}
                            <div>
                                <p className="mxg-room-name">{info.name}</p>
                                <p className="mxp-muted">{info.media?.title ? t("watching", { title: info.media.title }) : t("noMediaYet")}</p>
                                <p className="mxp-muted"><Users aria-hidden className="size-3 inline" /> {t("members", { count: info.members })}</p>
                            </div>
                        </div>
                    )}
                    <form className="mxg-form" onSubmit={submit}>
                        <label htmlFor="mxg-name" className="mxg-label">{t("nameLabel")}</label>
                        <input id="mxg-name" className="mxp-input" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={32}
                            autoComplete="nickname" placeholder={t("namePlaceholder")} required autoFocus />
                        <button type="submit" className="mxp-btn mxp-btn-primary" disabled={!draft.trim() || load.s !== "ok"}>{t("join")}</button>
                    </form>
                    <p className="mxp-muted mxg-fine">{t("privacy")}</p>
                </section>
            </main>
        );
    }

    return <GuestRoom server={server} invite={inv} name={name} initial={load.s === "ok" ? load.info : null} />;
}

function GuestMessage({ title, body, action }: { title: string; body: string; action?: { label: string; run(): void } }) {
    return (
        <main className="mxg-page">
            <section className="mxg-card" role="alert">
                <Clapperboard aria-hidden className="mxg-logo size-8" />
                <h1 className="mxg-title">{title}</h1>
                <p className="mxp-muted">{body}</p>
                {action && <button type="button" className="mxp-btn mxp-btn-primary" onClick={action.run}>{action.label}</button>}
            </section>
        </main>
    );
}

function GuestRoom({ server, invite, name, initial }: { server: string; invite: string; name: string; initial: InviteInfo | null }) {
    const t = useTranslations("mx.player");
    const [hub] = useState(() => {
        const h = new HubClient({ baseUrl: server, token: "", userId: "" }, () => null, APP_VERSION);
        h.guest = { invite, name };
        return h;
    });
    const chat = useRoomChat(hub);
    const [err, setErr] = useState<string | null>(null);
    const [left, setLeft] = useState(false);
    const [wasIn, setWasIn] = useState(false);

    useEffect(() => {
        hub.start();
        const off = hub.errors.on((e) => setErr(t(`together.${roomErrorKey(e)}`)));
        return () => { off(); hub.stop(); };
    }, [hub, t]);
    useEffect(() => {
        // A guest that leaves (or is dropped from) the room has nothing left to do here. A reconnect clears
        // the room only until the server re-joins us (the invite carries the room), so wait for the socket.
        const inRoom = !!chat.room;
        const h = window.setTimeout(() => {
            if (inRoom) setWasIn(true);
            else if (wasIn && chat.status === "connected") setLeft(true);
        }, inRoom ? 0 : 4000);
        return () => window.clearTimeout(h);
    }, [chat.room, chat.status, wasIn]);

    const auth = useMemo<StreamAuth>(() => ({ kind: "invite", invite }), [invite]);
    const media = chat.room?.media ?? null;

    if (left) {
        return <GuestMessage title={t("guest.leftTitle")} body={t("guest.leftBody")} />;
    }

    if (!media?.fileId) {
        return (
            <main className="mxg-page">
                <section className="mxg-card mxg-wide" aria-labelledby="mxg-wait">
                    <h1 id="mxg-wait" className="mxg-title">{chat.room?.name || initial?.name || t("together.title")}</h1>
                    <p className="mxp-muted" role="status">
                        {chat.status !== "connected" ? t("together.connecting") : chat.room ? t("guest.waitingHost") : t("guest.joining")}
                    </p>
                    {err && <p className="mxp-warn" role="alert">{err}</p>}
                    <TogetherPanel hub={hub} room={chat.room} status={chat.status} lines={chat.lines} canCreate={false}
                        serverBaseUrl={server} mediaSec={() => 0} notify={setErr} />
                </section>
            </main>
        );
    }

    return (
        <CinemaPlayer
            key={media.fileId}
            baseUrl={server}
            auth={auth}
            source={{
                fileId: media.fileId, title: media.title ?? chat.room?.name ?? "", kind: media.kind === "tv" || media.kind === "movie" ? media.kind : undefined,
                tmdbId: media.tmdbId, season: media.season ?? null, episode: media.episode ?? null, posterPath: media.posterPath ?? null,
                runtimeSec: media.durationSec ?? null,
                subtitle: media.season != null && media.episode != null ? t("route.episodeLabel", { season: media.season, episode: media.episode }) : null,
            }}
            startSec={Math.max(0, Math.floor(hub.roomExpectedPosition() ?? 0))}
            prefs={DEFAULT_PREFS}
            hub={hub}
            guest
            openTogether
            onExit={() => { hub.leave(); setLeft(true); }}
        />
    );
}
