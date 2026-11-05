/**
 * Now Playing (WP16-33): artwork, title/artist/album, progress, focusable controls (shuffle, prev,
 * play/pause, next, repeat, stop), Lyrics / Queue panel. Synced lyrics: the current line sits at ~40 % of
 * the panel height (translateY of the track), upcoming lines 50 % opacity. Queue: OK → skipTo.
 * Ambient after 60 s without a key: artwork + current lyric + clock (any key / Back wakes it).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/messages";
import { fmtClock } from "../lib/format";
import type { LyricLine, Lyrics } from "../lib/media-types";
import { musicPlayer, useMusicProgress, useMusicState } from "../lib/music-player";
import { useBackHandler } from "../nav/back";
import { useScreenActive } from "../nav/Nav";
import type { ScreenProps } from "../nav/ctx";
import { Chips, Empty, Icon, IconButton, LoadingBlock } from "../ui";
import { PlayingBars, useCoverBackdrop } from "./music/common";

const AMBIENT_MS = 60_000;

function currentLine(lines: LyricLine[], ms: number): number {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid]!.timeMs <= ms) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
}

function SyncedLyrics({ lines, index }: { lines: LyricLine[]; index: number }) {
    const box = useRef<HTMLDivElement>(null);
    const track = useRef<HTMLDivElement>(null);
    const [y, setY] = useState(0);
    useLayoutEffect(() => {
        const b = box.current, tr = track.current;
        if (!b || !tr) return;
        const el = tr.children[Math.max(0, index)] as HTMLElement | undefined;
        if (!el) return;
        setY(b.clientHeight * 0.4 - el.offsetTop - el.offsetHeight / 2);
    }, [index, lines]);
    return (
        <div ref={box} className="ly" data-testid="np-lyrics">
            <div ref={track} className="ly-track" style={{ transform: `translateY(${y}px)` }}>
                {lines.map((l, i) => (
                    <div key={i} className={`ly-line${i === index ? " is-now" : i < index ? " is-past" : ""}`}>{l.text || "♪"}</div>
                ))}
            </div>
        </div>
    );
}

export function NowPlaying({ ctx, params: _params }: ScreenProps<"nowPlaying">) {
    const { music, nav } = ctx;
    const st = useMusicState();
    const pr = useMusicProgress();
    const active = useScreenActive();
    const [panel, setPanel] = useState<"lyrics" | "queue">("lyrics");
    const [lyrics, setLyrics] = useState<Lyrics | null>(null);
    const [lyricsFor, setLyricsFor] = useState<string | null>(null);
    const [ambient, setAmbient] = useState(false);
    const [clock, setClock] = useState(() => new Date());
    const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
    const cur = st.current;

    useEffect(() => { musicPlayer.attach(music, ctx.media); }, [music, ctx.media]);
    useCoverBackdrop(cur ? music.coverUrl(cur, 64) : null);

    // Lyrics per track.
    useEffect(() => {
        if (!cur) return;
        if (lyricsFor === cur.id) return;
        let alive = true;
        setLyrics(null);
        setLyricsFor(cur.id);
        music.lyrics(cur.id).then((l) => { if (alive) setLyrics(l ?? { trackId: cur.id, synced: null, plain: null, source: "none" }); })
            .catch(() => { if (alive) setLyrics({ trackId: cur.id, synced: null, plain: null, source: "none" }); });
        return () => { alive = false; };
    }, [cur, music, lyricsFor]);

    // Ambient mode after 60 s idle (only while this screen is visible).
    const poke = useCallback(() => {
        if (idle.current) clearTimeout(idle.current);
        idle.current = setTimeout(() => setAmbient(true), AMBIENT_MS);
    }, []);
    useEffect(() => {
        if (!active) { if (idle.current) clearTimeout(idle.current); setAmbient(false); return; }
        poke();
        const onKey = (e: KeyboardEvent) => {
            if (ambient) { setAmbient(false); e.preventDefault(); e.stopImmediatePropagation(); }
            poke();
        };
        window.addEventListener("keydown", onKey, true);
        return () => { window.removeEventListener("keydown", onKey, true); if (idle.current) clearTimeout(idle.current); };
    }, [active, ambient, poke]);
    useBackHandler(() => { setAmbient(false); poke(); }, ambient);
    useEffect(() => {
        if (!ambient) return;
        const h = setInterval(() => setClock(new Date()), 10_000);
        return () => clearInterval(h);
    }, [ambient]);

    const synced = lyrics?.synced && lyrics.synced.length > 0 ? lyrics.synced : null;
    const lineIdx = synced ? currentLine(synced, pr.position * 1000 + 250) : -1;
    const lineText = synced && lineIdx >= 0 ? synced[lineIdx]!.text : null;

    // Keep the current queue item in view when the queue panel opens.
    const queueBox = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (panel !== "queue") return;
        const el = queueBox.current?.querySelector<HTMLElement>(".np-qitem.is-current");
        el?.scrollIntoView({ block: "center" });
    }, [panel, st.index]);

    const queueView = useMemo(() => st.queue.map((q, i) => ({ q, i })), [st.queue]);

    if (!cur) {
        return (
            <div className="tv-screen" data-scroll="screen" data-testid="screen-nowplaying">
                <Empty icon="music" title={st.restoring ? t("common.loading") : t("music.nothingPlaying")} message={t("music.nothingPlayingMsg")}
                    action={{ label: t("screen.music"), icon: "music", onClick: () => { if (!nav.pop()) nav.resetTo({ name: "music" }); } }} />
            </div>
        );
    }

    const art = music.coverUrl(cur, 600);
    const dur = pr.duration || cur.durationSec || 0;
    const pct = dur > 0 ? Math.min(1, pr.position / dur) : 0;
    const repeatIcon = st.repeat === "one" ? "repeatOne" : "repeat";
    const repeatLabel = st.repeat === "off" ? t("music.repeatOff") : st.repeat === "all" ? t("music.repeatAll") : t("music.repeatOne");

    return (
        <div className="np" data-testid="screen-nowplaying">
            <div className="np-left">
                <div className="np-art">{art ? <img src={art} alt="" decoding="async" /> : <span className="mu-hero-ph"><Icon name="music" /></span>}</div>
                <div>
                    <h1 className="np-title" data-testid="np-title">{cur.title}</h1>
                    <div className="np-sub">{[cur.artist, cur.album].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="np-progress">
                    <div className="np-bar"><span style={{ transform: `scaleX(${pct})` }} /></div>
                    <div className="np-times"><span>{fmtClock(pr.position)}</span><span>{st.error ? st.error : st.buffering ? t("common.loading") : ""}</span><span>{fmtClock(dur)}</span></div>
                </div>
                <div className="np-controls" data-focus-row="np-controls">
                    <IconButton icon="shuffle" label={st.shuffle ? t("music.shuffleOn") : t("music.shuffleOff")} active={st.shuffle} focusKey="np:shuffle" onClick={() => musicPlayer.setShuffle(!st.shuffle)} />
                    <IconButton icon="prev" label={t("music.prev")} focusKey="np:prev" onClick={() => musicPlayer.prev()} />
                    <IconButton icon={st.playing ? "pause" : "play"} label={st.playing ? t("player.pause") : t("player.play")} focusKey="np:toggle" className="np-main" onClick={() => musicPlayer.toggle()} testId="np-toggle" />
                    <IconButton icon="next" label={t("music.next")} focusKey="np:next" onClick={() => musicPlayer.next()} />
                    <IconButton icon={repeatIcon} label={repeatLabel} active={st.repeat !== "off"} focusKey="np:repeat" onClick={() => musicPlayer.cycleRepeat()} />
                    <IconButton icon="close" label={t("music.stop")} focusKey="np:stop" onClick={() => { musicPlayer.stop(); if (!nav.pop()) nav.resetTo({ name: "music" }); }} />
                </div>
            </div>
            <div className="np-right">
                <Chips className="np-tabs" rowId="np-tabs" value={panel} onChange={(id) => setPanel(id as "lyrics" | "queue")}
                    items={[{ id: "lyrics", label: t("music.lyrics"), icon: "lyrics" }, { id: "queue", label: t("music.queueCount", { n: st.queue.length }), icon: "queue" }]} />
                <div className="np-panel">
                    {panel === "lyrics" && (
                        !lyrics ? <LoadingBlock lines={5} />
                            : synced ? <SyncedLyrics lines={synced} index={lineIdx} />
                                : lyrics.plain ? <div className="ly-plain" data-scroll="np-lyrics" tabIndex={-1}>{lyrics.plain}</div>
                                    : <Empty icon="lyrics" title={t("music.noLyrics")} />
                    )}
                    {panel === "queue" && (
                        <div ref={queueBox} className="np-queue" data-scroll="np-queue" data-testid="np-queue">
                            {queueView.map(({ q, i }) => (
                                <button key={`${q.id}-${i}`} type="button" className={`np-qitem${i === st.index ? " is-current" : i < st.index ? " is-past" : ""}`}
                                    data-focusable="" data-focus-key={`np-q:${i}`} onClick={() => musicPlayer.skipTo(i)}>
                                    {music.coverUrl(q, 80) ? <img src={music.coverUrl(q, 80)!} alt="" loading="lazy" decoding="async" /> : <span className="np-qph"><Icon name="music" /></span>}
                                    <span className="mu-track-main">
                                        <span className="mu-track-title">{q.title}</span>
                                        <span className="mu-track-sub">{q.artist}</span>
                                    </span>
                                    {i === st.index && <PlayingBars playing={st.playing} />}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
            {ambient && (
                <div className="np-ambient" data-testid="np-ambient" aria-live="polite">
                    <div className="np-ambient-art">{art && <img src={art} alt="" decoding="async" />}</div>
                    <div className="np-ambient-body">
                        <div className="np-ambient-clock">{clock.toLocaleTimeString(ctx.lang === "ro" ? "ro-RO" : "en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
                        {lineText && <div className="np-ambient-line">{lineText}</div>}
                        <div className="np-ambient-meta">{[cur.title, cur.artist].filter(Boolean).join(" · ")}</div>
                    </div>
                </div>
            )}
        </div>
    );
}
