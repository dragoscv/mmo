/**
 * Year in review (WP16-35) from `GET /media/stats?year=` (media.stats): big numbers, month bars (divs scaled
 * with transform: scaleY), top genres + titles, listening hours/plays/top tracks; year picker (chips).
 * States: loading / empty (no activity) / error / server without `/media` (null).
 */
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/messages";
import type { MediaStats } from "../lib/media-types";
import type { ScreenProps } from "../nav/ctx";
import { useScreenActive } from "../nav/Nav";
import { Chips, Empty, ErrorState, LoadingBlock, ScreenHeader, useBackdrop } from "../ui";
import "./settings/settings.css";

type Load = { s: "loading" } | { s: "ok"; data: MediaStats } | { s: "none" } | { s: "error"; message: string };

const YEARS_BACK = 5;

function monthLabels(lang: "ro" | "en"): string[] {
    const fmt = (m: number) => {
        try { return new Date(2024, m, 1).toLocaleDateString(lang === "ro" ? "ro-RO" : "en-GB", { month: "short" }).replace(".", ""); }
        catch { return String(m + 1); }
    };
    return Array.from({ length: 12 }, (_, m) => fmt(m));
}

function hours(h: number): string {
    return h >= 100 ? String(Math.round(h)) : h.toFixed(1).replace(/\.0$/, "");
}

/** `srv:track:42` / `sha256:…` / `42` → something readable when the server gives no title. */
function trackLabel(key: string): string {
    const m = /(?:track:|tr_)?(\d+)$/.exec(key);
    return m ? t("st.track", { id: m[1] }) : key.slice(0, 24);
}

function Bars({ values, labels, listen }: { values: number[]; labels: string[]; listen?: boolean }) {
    const max = Math.max(0, ...values);
    const [shown, setShown] = useState(false);
    // Grow from 0 on mount (transform only).
    useEffect(() => { const h = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(h); }, []);
    return (
        <div className="st-bars" role="img" aria-label={values.map((v, i) => `${labels[i]} ${hours(v)}h`).join(", ")}>
            {labels.map((l, i) => {
                const v = values[i] ?? 0;
                return (
                    <div key={l + i} className="st-bar">
                        <div className="st-bar-track">
                            <div className={`st-bar-fill${listen ? " is-listen" : ""}`} style={{ transform: `scaleY(${shown && max > 0 ? v / max : 0})` }} />
                        </div>
                        <div className="st-bar-m">{l}</div>
                    </div>
                );
            })}
        </div>
    );
}

function Num({ v, l, hero }: { v: string; l: string; hero?: boolean }) {
    return <div className={`st-num${hero ? " st-num-hero" : ""}`}><div className="st-num-v">{v}</div><div className="st-num-l">{l}</div></div>;
}

export function Stats({ ctx, params }: ScreenProps<"stats">) {
    const thisYear = new Date().getFullYear();
    const [year, setYear] = useState<number>(params.year && params.year > 1990 ? params.year : thisYear);
    const [load, setLoad] = useState<Load>({ s: "loading" });
    // Text-heavy screen: no artwork behind it (cleared again each time it becomes the visible entry).
    const backdrop = useBackdrop();
    const screenActive = useScreenActive();
    useEffect(() => { if (screenActive) backdrop.clear(); }, [screenActive, backdrop]);

    const fetchYear = useCallback((y: number) => {
        setLoad({ s: "loading" });
        ctx.media.stats(y)
            .then((data) => setLoad(data ? { s: "ok", data } : { s: "none" }))
            .catch((e: Error) => setLoad({ s: "error", message: e.message }));
    }, [ctx.media]);
    useEffect(() => { fetchYear(year); }, [fetchYear, year]);

    const years = Array.from({ length: YEARS_BACK }, (_, i) => thisYear - i);
    const months = monthLabels(ctx.lang);
    const d = load.s === "ok" ? load.data : null;
    const empty = !!d && d.watch.hours <= 0 && d.listen.plays <= 0;
    const topGenreMax = d ? Math.max(0.0001, ...d.watch.topGenres.map((g) => g.hours)) : 1;

    return (
        <div className="tv-screen" data-scroll="screen" data-testid="screen-stats">
            <ScreenHeader title={t("st.title", { year })} sub={ctx.profiles.active ? t("set.forProfile", { name: ctx.profiles.active.name }) : undefined} />
            <Chips rowId="st-years" value={String(year)} onChange={(id) => setYear(Number(id))}
                items={years.map((y) => ({ id: String(y), label: String(y) }))} />
            {load.s === "loading" && <LoadingBlock lines={4} />}
            {load.s === "error" && <ErrorState message={t("st.error", { message: load.message })} onRetry={() => fetchYear(year)} />}
            {load.s === "none" && <Empty icon="star" title={t("st.unsupportedTitle")} message={t("st.unsupported")} />}
            {d && empty && <Empty icon="star" title={t("st.emptyTitle", { year })} message={t("st.empty")} />}
            {d && !empty && (
                <>
                    <div className="st-nums">
                        <Num hero v={hours(d.watch.hours)} l={t("st.hoursWatched")} />
                        <Num v={String(d.watch.movies)} l={t("st.movies")} />
                        <Num v={String(d.watch.episodes)} l={t("st.episodes")} />
                        <Num v={String(d.watch.completed)} l={t("st.completed")} />
                        <Num v={String(d.watch.longestStreakDays)} l={t("st.streak")} />
                    </div>
                    <div className="st-cols">
                        <section className="st-col">
                            <h2 className="set-h3">{t("st.byMonth")}</h2>
                            <Bars values={d.watch.byMonth} labels={months} />
                            <h2 className="set-h3">{t("st.topGenres")}</h2>
                            {d.watch.topGenres.length === 0 ? <div className="tg-dim tg-small">{t("st.none")}</div> : (
                                <ul className="st-list">
                                    {d.watch.topGenres.slice(0, 6).map((g, i) => (
                                        <li key={g.id} className="st-li">
                                            <span className="st-li-n">{i + 1}</span>
                                            <span className="st-li-name">{g.name}</span>
                                            <span className="st-meter"><span style={{ transform: `scaleX(${g.hours / topGenreMax})` }} /></span>
                                            <span className="st-li-v">{t("st.hours", { n: hours(g.hours) })}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        <section className="st-col">
                            <h2 className="set-h3">{t("st.topTitles")}</h2>
                            {d.watch.topTitles.length === 0 ? <div className="tg-dim tg-small">{t("st.none")}</div> : (
                                <ul className="st-list">
                                    {d.watch.topTitles.slice(0, 8).map((x, i) => (
                                        <li key={`${x.kind}:${x.tmdbId}`} className="st-li">
                                            <span className="st-li-n">{i + 1}</span>
                                            <button type="button" className="st-li-name set-row" data-focusable="" data-focus-key={`st:title:${x.kind}:${x.tmdbId}`}
                                                onClick={() => { if (x.kind === "movie" || x.kind === "tv") ctx.nav.push({ name: "title", kind: x.kind, tmdbId: x.tmdbId }); }}>
                                                {x.title}
                                            </button>
                                            <span className="st-li-v">{t("st.hours", { n: hours(x.hours) })}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                        <section className="st-col">
                            <h2 className="set-h3">{t("st.listening")}</h2>
                            <div className="st-nums">
                                <Num v={hours(d.listen.hours)} l={t("st.hoursListened")} />
                                <Num v={String(d.listen.plays)} l={t("st.plays")} />
                            </div>
                            <Bars values={d.listen.byMonth} labels={months} listen />
                            {d.listen.topTracks.length > 0 && (
                                <ul className="st-list">
                                    {d.listen.topTracks.slice(0, 5).map((x, i) => (
                                        <li key={x.trackKey} className="st-li">
                                            <span className="st-li-n">{i + 1}</span>
                                            <span className="st-li-name">{trackLabel(x.trackKey)}</span>
                                            <span className="st-li-v">{t("st.playsN", { n: x.plays })}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    </div>
                </>
            )}
        </div>
    );
}
