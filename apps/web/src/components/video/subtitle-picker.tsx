"use client";

import { useEffect, useState } from "react";
import { getSubtitleSearchAuthorized } from "@/actions/subtitles";

interface SubtitleResult {
    provider: string;
    id: string;
    language: string;
    title: string;
    release?: string;
    downloads?: number;
    downloadToken: string;
}

interface CompanionHandle {
    apiUrl: string;
    token: string;
    userId: string;
}

export function SubtitlePicker({ query, onPick, autoSelectLangs, preferSdh }: {
    query: { title?: string; tmdbId?: number; imdbId?: string; kind?: "movie" | "tv"; season?: number; episode?: number };
    onPick: (track: { src: string; lang: string; label: string }) => void;
    /** Priority list of language codes to auto-pick on mount (e.g. ["en","ro"]). */
    autoSelectLangs?: string[];
    /** Prefer SDH/CC variants when auto-selecting. */
    preferSdh?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [lang, setLang] = useState("ro,en");
    const [loading, setLoading] = useState(false);
    const [results, setResults] = useState<SubtitleResult[]>([]);
    const [error, setError] = useState<string | null>(null);

    const buildDownloadUrl = (r: SubtitleResult, handle: CompanionHandle) =>
        `${handle.apiUrl}/video/subs/download?provider=${r.provider}&id=${encodeURIComponent(r.downloadToken)}&lang=${r.language}&t=${encodeURIComponent(handle.token)}&u=${encodeURIComponent(handle.userId)}`;

    // Auto-select best match on mount (runs once per query identity)
    useEffect(() => {
        if (!autoSelectLangs || autoSelectLangs.length === 0) return;
        let cancelled = false;
        (async () => {
            const handle = await getSubtitleSearchAuthorized({
                ...query,
                lang: autoSelectLangs.join(","),
            });
            if (!handle || cancelled) return;
            const resp = await fetch(handle.searchUrl).catch(() => null);
            if (!resp || !resp.ok || cancelled) return;
            const j = await resp.json().catch(() => null) as { results?: SubtitleResult[] } | null;
            const all = j?.results ?? [];
            if (!all.length) return;
            for (const lc of autoSelectLangs) {
                const subset = all.filter((r) => r.language.toLowerCase() === lc.toLowerCase());
                if (!subset.length) continue;
                const sorted = [...subset].sort((a, b) => {
                    if (preferSdh) {
                        const sdhA = /sdh|cc|hi\b/i.test(a.release ?? a.title) ? 1 : 0;
                        const sdhB = /sdh|cc|hi\b/i.test(b.release ?? b.title) ? 1 : 0;
                        if (sdhA !== sdhB) return sdhB - sdhA;
                    }
                    return (b.downloads ?? 0) - (a.downloads ?? 0);
                });
                const pick = sorted[0];
                onPick({
                    src: buildDownloadUrl(pick, handle),
                    lang: pick.language,
                    label: `${pick.language.toUpperCase()} · ${pick.release ?? pick.title}`,
                });
                return;
            }
        })();
        return () => { cancelled = true; };
    // Re-run only when the underlying media identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query.tmdbId, query.imdbId, query.title, query.season, query.episode]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            const handle = await getSubtitleSearchAuthorized({ ...query, lang });
            if (cancelled) return;
            if (!handle) { setError("Companion neconectat"); setLoading(false); return; }
            try {
                const resp = await fetch(handle.searchUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const j = await resp.json() as { results?: SubtitleResult[] };
                if (!cancelled) setResults(j.results ?? []);
            } catch (e) {
                if (!cancelled) setError((e as Error).message);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open, lang, query.title, query.tmdbId, query.imdbId, query.kind, query.season, query.episode, query]);

    const pick = async (r: SubtitleResult) => {
        const handle = await getSubtitleSearchAuthorized(query);
        if (!handle) return;
        onPick({
            src: buildDownloadUrl(r, handle),
            lang: r.language,
            label: `${r.language.toUpperCase()} · ${r.release ?? r.title}`,
        });
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
                    position: "absolute", top: "calc(100% + 6px)", right: 0, width: 360, maxHeight: 380, overflow: "auto",
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
