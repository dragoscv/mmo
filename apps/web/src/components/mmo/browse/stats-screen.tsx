"use client";

/**
 * Year in review (`/media/stats`, `GET /media/stats?year=`): hero numbers, monthly bars (pure CSS, transform only),
 * top genres + titles, listening hours/plays/top tracks; year picker in `?year=`.
 */
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { BarChart3 } from "lucide-react";
import { EmptyState } from "@mmo/ui";
import type { MediaStats } from "@/lib/mmo/media-types";
import { ErrorBlock, Unsupported, useMediaScope } from "./common";
import { barScale, hoursLabel, yearsBack } from "./lib";
import { useAsync } from "./use-async";

const YEARS = 6;

export function StatsScreen() {
    const t = useTranslations("mx.browse.stats");
    const locale = useLocale();
    const fmt = useFormatter();
    const { media, scope } = useMediaScope();
    const params = useSearchParams();
    const router = useRouter();
    const pathname = usePathname() ?? "/media/stats";
    const now = new Date().getFullYear();
    const raw = Number(params?.get("year"));
    const year = Number.isInteger(raw) && raw > 1990 && raw <= now ? raw : now;
    const { load, retry } = useAsync<MediaStats>(scope ? `${scope}|stats|${year}` : null, () => (media ? media.stats(year) : Promise.resolve(null)));

    const months = useMemo(() => Array.from({ length: 12 }, (_, m) => fmt.dateTime(new Date(2024, m, 1), { month: "short" })), [fmt]);
    const h = (v: number) => hoursLabel(v, locale);
    const data = load.s === "ok" ? load.data : null;
    const empty = data && data.watch.hours <= 0 && data.listen.plays <= 0 && data.watch.titles <= 0;

    return (
        <div>
            <div className="mx-page-head">
                <h1 className="mx-page-title">{t("title", { year })}</h1>
                <nav className="mxb-chips" aria-label={t("year")}>
                    {yearsBack(now, YEARS).map((y) => (
                        <button key={y} type="button" className="mxb-chip" aria-pressed={y === year} onClick={() => router.replace(y === now ? pathname : `${pathname}?year=${y}`, { scroll: false })}>
                            {y}
                        </button>
                    ))}
                </nav>
            </div>

            {load.s === "loading" ? (
                <div aria-busy>
                    <p className="sr-only" role="status">{t("loading")}</p>
                    <div className="mxb-nums" aria-hidden>{Array.from({ length: 5 }, (_, i) => <div key={i} className="mxb-skel-block bg-muted animate-pulse" style={{ height: "6rem" }} />)}</div>
                    <div className="mxb-skel-block bg-muted animate-pulse mt-4" style={{ height: "14rem" }} aria-hidden />
                </div>
            ) : null}
            {load.s === "error" ? <ErrorBlock error={load.error} onRetry={retry} /> : null}
            {load.s === "unsupported" ? <Unsupported /> : null}
            {empty ? <EmptyState icon={<BarChart3 aria-hidden />} title={t("empty", { year })} description={t("emptyBody")} /> : null}

            {data && !empty ? (
                <div className="flex flex-col gap-4">
                    <div className="mxb-nums">
                        <Num hero value={h(data.watch.hours)} label={t("hoursWatched")} />
                        <Num value={fmt.number(data.watch.movies)} label={t("movies", { count: data.watch.movies })} />
                        <Num value={fmt.number(data.watch.episodes)} label={t("episodes", { count: data.watch.episodes })} />
                        <Num value={fmt.number(data.watch.completed)} label={t("completed")} />
                        <Num value={fmt.number(data.watch.longestStreakDays)} label={t("streak", { count: data.watch.longestStreakDays })} />
                    </div>
                    <div className="mxb-panels">
                        <section className="mxb-panel" aria-labelledby="mxb-st-month">
                            <h2 id="mxb-st-month" className="mxb-h2">{t("byMonth")}</h2>
                            <Bars values={data.watch.byMonth} labels={months} unit={(v) => t("hoursShort", { h: h(v) })} />
                        </section>
                        <section className="mxb-panel" aria-labelledby="mxb-st-genres">
                            <h2 id="mxb-st-genres" className="mxb-h2">{t("topGenres")}</h2>
                            <Ranked items={data.watch.topGenres.slice(0, 8).map((g) => ({ key: String(g.id), label: g.name, value: g.hours }))} unit={(v) => t("hoursShort", { h: h(v) })} empty={t("none")} />
                        </section>
                        <section className="mxb-panel" aria-labelledby="mxb-st-titles">
                            <h2 id="mxb-st-titles" className="mxb-h2">{t("topTitles")}</h2>
                            <Ranked
                                items={data.watch.topTitles.slice(0, 10).map((x) => ({
                                    key: `${x.kind}:${x.tmdbId}`, label: x.title, value: x.hours,
                                    href: x.kind === "movie" || x.kind === "tv" ? `/media/${x.kind}/${x.tmdbId}` : undefined,
                                }))}
                                unit={(v) => t("hoursShort", { h: h(v) })}
                                empty={t("none")}
                            />
                        </section>
                    </div>
                    <h2 className="mxb-h2 mt-4">{t("listening")}</h2>
                    <div className="mxb-nums">
                        <Num value={h(data.listen.hours)} label={t("hoursListened")} />
                        <Num value={fmt.number(data.listen.plays)} label={t("plays", { count: data.listen.plays })} />
                    </div>
                    {data.listen.plays > 0 ? (
                        <div className="mxb-panels">
                            <section className="mxb-panel" aria-labelledby="mxb-st-lmonth">
                                <h2 id="mxb-st-lmonth" className="mxb-h2">{t("listenByMonth")}</h2>
                                <Bars values={data.listen.byMonth} labels={months} alt unit={(v) => t("hoursShort", { h: h(v) })} />
                            </section>
                            <section className="mxb-panel" aria-labelledby="mxb-st-tracks">
                                <h2 id="mxb-st-tracks" className="mxb-h2">{t("topTracks")}</h2>
                                <Ranked items={data.listen.topTracks.slice(0, 10).map((x) => ({ key: x.trackKey, label: trackLabel(x.trackKey, t("track")), value: x.plays }))} unit={(v) => t("playsShort", { count: v })} empty={t("none")} />
                            </section>
                        </div>
                    ) : null}
                    <p className="text-muted-foreground text-sm">
                        <Link href="/media" className="hover:underline">{t("back")}</Link>
                    </p>
                </div>
            ) : null}
        </div>
    );
}

function trackLabel(key: string, word: string): string {
    const m = /(?:track:|tr_)?(\d+)$/.exec(key);
    return m ? `${word} ${m[1]}` : key.slice(0, 32);
}

function Num({ value, label, hero }: { value: string; label: string; hero?: boolean }) {
    return <div className="mxb-num" data-hero={hero || undefined}><div className="mxb-num-v">{value}</div><div className="mxb-num-l">{label}</div></div>;
}

function Bars({ values, labels, unit, alt }: { values: number[]; labels: string[]; unit: (v: number) => string; alt?: boolean }) {
    const [shown, setShown] = useState(false);
    useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }, []);
    const scale = barScale(labels.map((_, i) => values[i] ?? 0));
    return (
        <div className="mxb-bars" role="img" aria-label={labels.map((l, i) => `${l} ${unit(values[i] ?? 0)}`).join(", ")}>
            {labels.map((l, i) => (
                <div key={i} className="mxb-bar" title={`${l}: ${unit(values[i] ?? 0)}`}>
                    <div className="mxb-bar-track">
                        <div className="mxb-bar-fill" data-alt={alt || undefined} style={{ transform: `scaleY(${shown ? scale[i] ?? 0 : 0})` }} />
                    </div>
                    <span className="mxb-bar-m" aria-hidden>{l}</span>
                </div>
            ))}
        </div>
    );
}

function Ranked({ items, unit, empty }: { items: { key: string; label: string; value: number; href?: string }[]; unit: (v: number) => string; empty: string }) {
    if (items.length === 0) return <p className="text-muted-foreground text-sm">{empty}</p>;
    const scale = barScale(items.map((x) => x.value));
    return (
        <ol className="mxb-rank">
            {items.map((x, i) => (
                <li key={x.key}>
                    <span className="mxb-rank-n">{i + 1}</span>
                    <span className="truncate">{x.href ? <Link href={x.href}>{x.label}</Link> : x.label}</span>
                    <span className="mxb-count">{unit(x.value)}</span>
                    <span className="mxb-rank-bar" aria-hidden><span style={{ width: `${Math.round((scale[i] ?? 0) * 100)}%` }} /></span>
                </li>
            ))}
        </ol>
    );
}
