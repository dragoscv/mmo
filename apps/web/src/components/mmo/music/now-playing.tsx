"use client";

/**
 * `/media/music/now-playing` (WP16-40): large cover over a blurred cover backdrop, seek bar, transport,
 * volume; Lyrics / Queue panel. Synced lyrics auto-scroll to keep the current line centred (instant under
 * reduced motion; paused 4 s after the user scrolls), click a line to seek. Queue: play, move up/down, remove.
 * Space toggles play when focus is not in a form field.
 */
import Link from "@/components/host/host-context";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, ListMusic, Mic2, Music2, Volume1, Volume2, VolumeX, X } from "lucide-react";
import { Button, EmptyState } from "@mmo/ui";
import type { LyricLine, Lyrics } from "@/lib/mmo/media-types";
import type { MusicClient } from "@/lib/mmo/music";
import { currentLineIndex, fmtClock, looksLikeLrc, parseLrc } from "@/lib/mmo/music-core";
import { useWebMusicProgress, useWebMusicState, useWebMusicVolume, webMusicPlayer } from "@/lib/mmo/web-music-player";
import { Cover, PlayingBars, albumHref, artistHref } from "./common";
import { NextButton, PlayPauseButton, PrevButton, RepeatButton, ShuffleButton } from "./transport";
import { useLoad, useMusic } from "./use-music";

function prefersReducedMotion(): boolean {
    if (typeof window === "undefined") return false;
    return document.documentElement.dataset.motion === "reduced" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isTypingTarget(el: EventTarget | null): boolean {
    if (!(el instanceof HTMLElement)) return false;
    return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.getAttribute("role") === "slider";
}

export function NowPlayingScreen() {
    const t = useTranslations("mx.music");
    const { music } = useMusic();
    const st = useWebMusicState();
    const [panel, setPanel] = useState<"lyrics" | "queue">("lyrics");
    const cur = st.hidden ? null : st.current;

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
            if (e.key === " " && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLAnchorElement)) {
                e.preventDefault();
                webMusicPlayer.toggle();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    if (!music) return null;
    if (!cur) {
        return (
            <div className="mu-page">
                <EmptyState icon={<Music2 aria-hidden />} title={st.restoring ? t("state.loading") : t("player.nothing")} description={t("player.nothingBody")}
                    actions={<Button render={<Link href="/media/music" />}>{t("state.backToMusic")}</Button>} />
            </div>
        );
    }

    return (
        <div className="np" data-testid="music-now-playing">
            {music.coverUrl(cur, 120) ? (
                // eslint-disable-next-line @next/next/no-img-element -- decorative blurred cover backdrop
                <img className="np-bg" src={music.coverUrl(cur, 120) ?? ""} alt="" aria-hidden decoding="async" />
            ) : null}
            <div className="np-bg-scrim" aria-hidden />
            <div className="np-left">
                <Cover src={music.coverUrl(cur, 800)} className="np-art" eager />
                <div className="np-meta">
                    <h1 className="np-title" data-testid="np-title">{cur.title}</h1>
                    <p className="np-sub">
                        {cur.artist ? (cur.artistId ? <Link href={artistHref(cur.artistId)}>{cur.artist}</Link> : <span>{cur.artist}</span>) : null}
                        {cur.album ? (cur.albumId ? <Link href={albumHref(cur.albumId)}>{cur.album}</Link> : <span>{cur.album}</span>) : null}
                    </p>
                </div>
                <SeekBar fallbackDuration={cur.durationSec} error={st.error !== null} buffering={st.buffering} />
                <div className="np-controls" role="group" aria-label={t("player.controls")}>
                    <ShuffleButton st={st} />
                    <PrevButton />
                    <PlayPauseButton st={st} />
                    <NextButton />
                    <RepeatButton st={st} />
                </div>
                <VolumeControl />
            </div>
            <div className="np-right">
                <div className="np-tabs" role="group" aria-label={t("player.panel")}>
                    <button type="button" className="mu-chip" aria-pressed={panel === "lyrics"} onClick={() => setPanel("lyrics")}>
                        <Mic2 aria-hidden className="size-4" />{t("player.lyrics")}
                    </button>
                    <button type="button" className="mu-chip" aria-pressed={panel === "queue"} onClick={() => setPanel("queue")}>
                        <ListMusic aria-hidden className="size-4" />{t("player.queue", { count: st.queue.length })}
                    </button>
                </div>
                <div className="np-panel">
                    {panel === "lyrics" ? <LyricsPanel music={music} trackId={cur.id} /> : <QueuePanel music={music} />}
                </div>
            </div>
        </div>
    );
}

function SeekBar({ fallbackDuration, error, buffering }: { fallbackDuration: number; error: boolean; buffering: boolean }) {
    const t = useTranslations("mx.music.player");
    const pr = useWebMusicProgress();
    const [drag, setDrag] = useState<number | null>(null);
    const dur = pr.duration || fallbackDuration || 0;
    const pos = drag ?? pr.position;
    return (
        <div className="np-progress">
            <input type="range" className="np-range" min={0} max={Math.max(1, Math.floor(dur))} step={1} value={Math.min(Math.floor(pos), Math.floor(dur))}
                aria-label={t("seek")} aria-valuetext={`${fmtClock(pos)} / ${fmtClock(dur)}`}
                onChange={(e) => setDrag(Number(e.target.value))}
                onPointerUp={() => { if (drag !== null) { webMusicPlayer.seek(drag); setDrag(null); } }}
                onKeyUp={() => { if (drag !== null) { webMusicPlayer.seek(drag); setDrag(null); } }}
                onBlur={() => { if (drag !== null) { webMusicPlayer.seek(drag); setDrag(null); } }} />
            <div className="np-times">
                <span>{fmtClock(pos)}</span>
                <span role="status">{error ? t("error") : buffering ? t("buffering") : ""}</span>
                <span>{fmtClock(dur)}</span>
            </div>
        </div>
    );
}

function VolumeControl() {
    const t = useTranslations("mx.music.player");
    const v = useWebMusicVolume();
    const level = v.muted ? 0 : v.volume;
    const Icon = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;
    return (
        <div className="np-volume">
            <button type="button" className="np-ctl" aria-pressed={v.muted} aria-label={v.muted ? t("unmute") : t("mute")} onClick={() => webMusicPlayer.setMuted(!v.muted)}>
                <Icon aria-hidden className="size-5" />
            </button>
            <input type="range" min={0} max={100} step={1} value={Math.round(level * 100)} aria-label={t("volume")}
                aria-valuetext={`${Math.round(level * 100)} %`} onChange={(e) => webMusicPlayer.setVolume(Number(e.target.value) / 100)} />
        </div>
    );
}

// ─── lyrics ─────────────────────────────────────────────────────────────────

function LyricsPanel({ music, trackId }: { music: MusicClient; trackId: string }) {
    const t = useTranslations("mx.music.player");
    const r = useLoad<Lyrics | null>(`ly|${trackId}`, () => music.lyrics(trackId));
    const synced = useMemo<LyricLine[] | null>(() => {
        const l = r.data;
        if (!l) return null;
        if (l.synced && l.synced.length > 0) return l.synced;
        if (looksLikeLrc(l.plain)) { const p = parseLrc(l.plain ?? ""); return p.length > 0 ? p : null; }
        return null;
    }, [r.data]);

    if (r.status === "loading") return <div className="ly-empty" role="status">{t("lyricsLoading")}</div>;
    if (r.status === "error") return <div className="ly-empty"><Button variant="outline" onClick={r.retry}>{t("lyricsRetry")}</Button></div>;
    if (synced) return <SyncedLyrics lines={synced} />;
    if (r.data?.plain) return <div className="ly-plain" tabIndex={0} aria-label={t("lyrics")}>{r.data.plain}</div>;
    return <div className="ly-empty">{t("noLyrics")}</div>;
}

function SyncedLyrics({ lines }: { lines: LyricLine[] }) {
    const t = useTranslations("mx.music.player");
    const pr = useWebMusicProgress();
    const box = useRef<HTMLDivElement>(null);
    const userScrollAt = useRef(0);
    const idx = currentLineIndex(lines, pr.position * 1000 + 250);

    useEffect(() => {
        const b = box.current;
        if (!b || idx < 0 || Date.now() - userScrollAt.current < 4000) return;
        const el = b.querySelector<HTMLElement>(`[data-line="${idx}"]`);
        if (!el) return;
        const top = el.offsetTop - b.clientHeight / 2 + el.offsetHeight / 2;
        b.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }, [idx]);

    const markUser = () => { userScrollAt.current = Date.now(); };

    return (
        <div ref={box} className="ly" data-testid="np-lyrics" onWheel={markUser} onTouchMove={markUser} aria-label={t("lyrics")} role="group">
            {lines.map((l, i) => (
                <button key={i} type="button" data-line={i} className={`ly-line${i === idx ? " is-now" : i < idx ? " is-past" : ""}`}
                    aria-current={i === idx ? "true" : undefined} aria-label={t("seekToLine", { time: fmtClock(l.timeMs / 1000), text: l.text || "♪" })}
                    onClick={() => { userScrollAt.current = 0; webMusicPlayer.seek(l.timeMs / 1000); }}>
                    {l.text || "♪"}
                </button>
            ))}
        </div>
    );
}

// ─── queue ──────────────────────────────────────────────────────────────────

function QueuePanel({ music }: { music: MusicClient }) {
    const t = useTranslations("mx.music.player");
    const st = useWebMusicState();
    const list = useRef<HTMLOListElement>(null);

    useEffect(() => {
        const el = list.current?.querySelector<HTMLElement>(".np-qitem.is-current");
        el?.scrollIntoView({ block: "center", behavior: "auto" });
    }, [st.index]);

    if (st.queue.length === 0) return <div className="ly-empty">{t("queueEmpty")}</div>;
    const last = st.queue.length - 1;

    return (
        <ol ref={list} className="np-queue" aria-label={t("queueLabel")} data-testid="np-queue">
            {st.queue.map((q, i) => (
                <li key={`${q.id}-${i}`} className={`np-qitem${i === st.index ? " is-current" : i < st.index ? " is-past" : ""}`}>
                    <button type="button" className="np-qplay" onClick={() => webMusicPlayer.skipTo(i)} aria-current={i === st.index ? "true" : undefined}
                        aria-label={t("playItem", { title: [q.title, q.artist].filter(Boolean).join(" – ") })}>
                        <Cover src={music.coverUrl(q, 80)} />
                        <span className="mu-track-main">
                            <span className="mu-track-title">{q.title}</span>
                            <span className="mu-track-sub">{q.artist}</span>
                        </span>
                        {i === st.index ? <PlayingBars playing={st.playing} /> : <span className="mu-track-dur">{fmtClock(q.durationSec)}</span>}
                    </button>
                    <span className="np-qtools">
                        <button type="button" className="np-qtool" disabled={i === 0} aria-label={t("moveUp", { title: q.title })} onClick={() => webMusicPlayer.moveInQueue(i, i - 1)}>
                            <ArrowUp aria-hidden className="size-4" />
                        </button>
                        <button type="button" className="np-qtool" disabled={i === last} aria-label={t("moveDown", { title: q.title })} onClick={() => webMusicPlayer.moveInQueue(i, i + 1)}>
                            <ArrowDown aria-hidden className="size-4" />
                        </button>
                        <button type="button" className="np-qtool" aria-label={t("remove", { title: q.title })} onClick={() => webMusicPlayer.removeFromQueue(i)}>
                            <X aria-hidden className="size-4" />
                        </button>
                    </span>
                </li>
            ))}
        </ol>
    );
}
