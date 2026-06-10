"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, Shield, X } from "lucide-react";
import { STREAM_SOURCES, getDefaultStreamSource, type StreamSourceKind } from "@/lib/video/stream-sources";

interface Props {
    kind: StreamSourceKind;
    tmdbId: number;
    imdbId?: string | null;
    /** For TV: initial season/episode (defaults to 1/1). */
    season?: number;
    episode?: number;
    /** For TV: episode count per season — drives the episode dropdown. */
    seasons?: Array<{ season: number; episodeCount: number; label?: string }>;
}

const LS_KEY = "mmo:watch:lastSource";

export function StreamSourcePicker({ kind, tmdbId, imdbId, season: initialSeason, episode: initialEpisode, seasons }: Props) {
    const [sourceId, setSourceId] = useState<string>(getDefaultStreamSource(kind).id);
    const [season, setSeason] = useState<number>(initialSeason ?? 1);
    const [episode, setEpisode] = useState<number>(initialEpisode ?? 1);
    const [iframeKey, setIframeKey] = useState(0);
    const [dismissed, setDismissed] = useState(false);

    // Restore last-used provider per kind
    useEffect(() => {
        const stored = localStorage.getItem(`${LS_KEY}:${kind}`);
        if (stored && STREAM_SOURCES.some((s) => s.id === stored)) setSourceId(stored);
    }, [kind]);

    useEffect(() => {
        localStorage.setItem(`${LS_KEY}:${kind}`, sourceId);
    }, [sourceId, kind]);

    const source = STREAM_SOURCES.find((s) => s.id === sourceId) ?? STREAM_SOURCES[0];
    const url = useMemo(() => {
        return kind === "movie"
            ? source.movie(tmdbId, imdbId ?? null)
            : source.tv(tmdbId, season, episode, imdbId ?? null);
    }, [source, kind, tmdbId, imdbId, season, episode]);

    const currentSeasonInfo = seasons?.find((s) => s.season === season);
    const maxEpisode = currentSeasonInfo?.episodeCount ?? 30;

    function reload() {
        setIframeKey((k) => k + 1);
    }

    return (
        <section
            className="stream-source-picker"
            style={{
                display: "grid",
                gap: ".75rem",
                padding: "1rem",
                borderRadius: 12,
                background: "var(--watch-bg-2)",
                border: "1px solid color-mix(in srgb, var(--watch-fg) 8%, transparent)",
            }}
        >
            {!dismissed && (
                <div
                    role="note"
                    style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: ".75rem",
                        padding: ".75rem .9rem",
                        borderRadius: 10,
                        background: "color-mix(in srgb, var(--watch-accent) 8%, transparent)",
                        border: "1px solid color-mix(in srgb, var(--watch-accent) 22%, transparent)",
                        fontSize: ".8rem",
                        lineHeight: 1.45,
                    }}
                >
                    <AlertTriangle size={16} style={{ marginTop: 2, flex: "0 0 auto", color: "var(--watch-accent)" }} />
                    <div style={{ flex: 1 }}>
                        <strong style={{ display: "block", marginBottom: 2 }}>Conținut găzduit de terți</strong>
                        Sandbox activ împotriva pop-up-urilor. Dacă un player nu pornește, alege alt provider — sunt mirror-uri independente.
                    </div>
                    <button
                        type="button"
                        onClick={() => setDismissed(true)}
                        aria-label="Închide nota"
                        style={{ background: "transparent", border: 0, color: "var(--watch-fg-dim)", cursor: "pointer", padding: 2 }}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}

            <div style={{ display: "flex", flexWrap: "wrap", gap: ".4rem" }}>
                {STREAM_SOURCES.map((s) => {
                    const active = s.id === sourceId;
                    return (
                        <button
                            key={s.id}
                            type="button"
                            onClick={() => setSourceId(s.id)}
                            className="watch-pill"
                            style={{
                                cursor: "pointer",
                                background: active ? "var(--watch-accent)" : "var(--watch-bg-3, transparent)",
                                color: active ? "#fff" : "var(--watch-fg)",
                                borderColor: active ? "var(--watch-accent)" : undefined,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: ".35rem",
                            }}
                            title={s.hint ? `${s.label} — ${s.hint}` : s.label}
                        >
                            {s.clean && <Shield size={11} aria-hidden />}
                            {s.label}
                        </button>
                    );
                })}
            </div>

            {kind === "tv" && seasons && seasons.length > 0 && (
                <div style={{ display: "flex", gap: ".5rem", alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ fontSize: ".85rem", color: "var(--watch-fg-dim)" }}>Sezon</label>
                    <select
                        value={season}
                        onChange={(e) => { const v = Number(e.target.value); setSeason(v); setEpisode(1); }}
                        style={{
                            padding: ".35rem .6rem", borderRadius: 8, background: "var(--watch-bg-3, transparent)",
                            border: "1px solid color-mix(in srgb, var(--watch-fg) 12%, transparent)", color: "var(--watch-fg)",
                        }}
                    >
                        {seasons.map((s) => (
                            <option key={s.season} value={s.season}>{s.label ?? `Sezonul ${s.season}`}</option>
                        ))}
                    </select>

                    <label style={{ fontSize: ".85rem", color: "var(--watch-fg-dim)", marginLeft: ".5rem" }}>Episod</label>
                    <button
                        type="button"
                        aria-label="Episod anterior"
                        disabled={episode <= 1}
                        onClick={() => setEpisode((e) => Math.max(1, e - 1))}
                        style={{ padding: ".3rem", borderRadius: 6, background: "transparent", border: "1px solid color-mix(in srgb, var(--watch-fg) 12%, transparent)", color: "var(--watch-fg)", cursor: episode <= 1 ? "default" : "pointer", opacity: episode <= 1 ? 0.4 : 1 }}
                    >
                        <ChevronLeft size={14} />
                    </button>
                    <span style={{ minWidth: 36, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>E{String(episode).padStart(2, "0")}</span>
                    <button
                        type="button"
                        aria-label="Episod următor"
                        disabled={episode >= maxEpisode}
                        onClick={() => setEpisode((e) => Math.min(maxEpisode, e + 1))}
                        style={{ padding: ".3rem", borderRadius: 6, background: "transparent", border: "1px solid color-mix(in srgb, var(--watch-fg) 12%, transparent)", color: "var(--watch-fg)", cursor: episode >= maxEpisode ? "default" : "pointer", opacity: episode >= maxEpisode ? 0.4 : 1 }}
                    >
                        <ChevronRight size={14} />
                    </button>
                </div>
            )}

            <div
                style={{
                    position: "relative",
                    aspectRatio: "16/9",
                    width: "100%",
                    borderRadius: 12,
                    overflow: "hidden",
                    background: "#000",
                    boxShadow: "0 20px 60px rgba(0,0,0,.5)",
                }}
            >
                <iframe
                    key={`${sourceId}-${season}-${episode}-${iframeKey}`}
                    src={url}
                    title={`${source.label} player`}
                    referrerPolicy="no-referrer"
                    allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                    allowFullScreen
                    sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
                    style={{ width: "100%", height: "100%", border: 0, display: "block" }}
                />
            </div>

            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", fontSize: ".8rem", color: "var(--watch-fg-dim)" }}>
                <button
                    type="button"
                    onClick={reload}
                    className="watch-pill"
                    style={{ cursor: "pointer", background: "var(--watch-bg-3, transparent)", color: "var(--watch-fg)" }}
                >
                    Reîncarcă playerul
                </button>
                <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="watch-pill"
                    style={{ display: "inline-flex", alignItems: "center", gap: ".35rem", textDecoration: "none", color: "var(--watch-fg)" }}
                >
                    Deschide în tab nou <ExternalLink size={12} />
                </a>
                <span style={{ marginLeft: "auto" }}>Activ: <strong>{source.label}</strong></span>
            </div>
        </section>
    );
}
