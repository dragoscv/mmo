"use client";

import { useEffect, useState } from "react";

const COMPANION_BASE = process.env.NEXT_PUBLIC_COMPANION_BASE_URL || "http://127.0.0.1:17899";

interface SubtitleResult {
    provider: string;
    id: string;
    language: string;
    title: string;
    release?: string;
    downloads?: number;
    downloadToken: string;
}

interface AuthHandle {
    token: string;
    userId: string;
}

function readAuth(): AuthHandle | null {
    if (typeof window === "undefined") return null;
    const token = window.localStorage.getItem("mmo-device-token") ?? "";
    const userId = window.localStorage.getItem("mmo-user-id") ?? "";
    if (!token || !userId) return null;
    return { token, userId };
}

export function SubtitlePicker({ query, onPick }: {
    query: { title?: string; tmdbId?: number; imdbId?: string; kind?: "movie" | "tv"; season?: number; episode?: number };
    onPick: (track: { src: string; lang: string; label: string }) => void;
}) {
    const [open, setOpen] = useState(false);
    const [lang, setLang] = useState("ro,en");
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState<SubtitleResult[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        const auth = readAuth();
        if (!auth) { setError("Companion neconectat"); return; }
        const params = new URLSearchParams();
        if (query.title) params.set("title", query.title);
        if (query.tmdbId) params.set("tmdb", String(query.tmdbId));
        if (query.imdbId) params.set("imdb", query.imdbId);
        if (query.kind) params.set("kind", query.kind);
        if (query.season != null) params.set("season", String(query.season));
        if (query.episode != null) params.set("episode", String(query.episode));
        if (lang) params.set("lang", lang);
        setLoading(true);
        setError(null);
        fetch(`${COMPANION_BASE}/video/subs/search?${params}`, {
            headers: { "X-Device-Token": auth.token, "X-User-Id": auth.userId },
        })
            .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
            .then((j: { results?: SubtitleResult[] }) => setResults(j.results ?? []))
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, [open, lang, query.title, query.tmdbId, query.imdbId, query.kind, query.season, query.episode]);

    const pick = (r: SubtitleResult) => {
        const auth = readAuth();
        if (!auth) return;
        const url = `${COMPANION_BASE}/video/subs/download?provider=${r.provider}&id=${encodeURIComponent(r.downloadToken)}&lang=${r.language}&t=${encodeURIComponent(auth.token)}&u=${encodeURIComponent(auth.userId)}`;
        onPick({ src: url, lang: r.language, label: `${r.language.toUpperCase()} · ${r.release ?? r.title}` });
        setOpen(false);
    };

    return (
        <div style={{ position: "relative" }}>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                style={{
                    background: "rgba(0,0,0,.55)", color: "#fff", border: "1px solid rgba(255,255,255,.2)",
                    borderRadius: 6, padding: "4px 10px", fontSize: ".8rem", cursor: "pointer",
                }}
                aria-expanded={open}
            >
                CC
            </button>
            {open && (
                <div role="dialog" style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0, width: 360, maxHeight: 380, overflow: "auto",
                    background: "rgba(20,20,22,.96)", color: "#fff", border: "1px solid rgba(255,255,255,.1)", borderRadius: 8,
                    padding: 10, zIndex: 100, boxShadow: "0 8px 24px rgba(0,0,0,.5)",
                }}>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                        <input
                            value={lang}
                            onChange={e => setLang(e.target.value)}
                            placeholder="ro,en"
                            style={{ flex: 1, background: "rgba(255,255,255,.05)", border: "1px solid rgba(255,255,255,.15)", borderRadius: 4, padding: "4px 6px", color: "#fff", fontSize: ".8rem" }}
                        />
                        <button type="button" onClick={() => setOpen(false)} style={{ background: "transparent", border: "none", color: "#aaa", cursor: "pointer" }}>×</button>
                    </div>
                    {loading && <div style={{ fontSize: ".8rem", opacity: .7 }}>Caut...</div>}
                    {error && <div style={{ fontSize: ".8rem", color: "#ff7070" }}>{error}</div>}
                    {!loading && !error && results.length === 0 && <div style={{ fontSize: ".8rem", opacity: .6 }}>Niciun rezultat. Verifică OPENSUBTITLES_API_KEY pe companion.</div>}
                    {results.map((r) => (
                        <button
                            key={`${r.provider}-${r.id}`}
                            type="button"
                            onClick={() => pick(r)}
                            style={{
                                display: "block", width: "100%", textAlign: "left", padding: "6px 8px",
                                background: "transparent", color: "#fff", border: "none", cursor: "pointer",
                                borderRadius: 4, fontSize: ".8rem",
                            }}
                            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,.08)")}
                            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                        >
                            <strong>{r.language.toUpperCase()}</strong> · {r.release ?? r.title}
                            {r.downloads != null && <span style={{ opacity: .5 }}> · {r.downloads.toLocaleString()} ↓</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
