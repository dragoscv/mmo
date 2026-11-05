/**
 * Title (WP16-33): backdrop, poster (FLIP from the source card), logo/title, chips (year · age · runtime · 4K/HDR/DV),
 * tagline, overview, genres; Play/Resume (movie: best version; series: nextUp) · Start over · Trailer (YouTube app,
 * browser, else QR) · Versions (SidePanel when > 1 file) · My list · Mark watched; Where to watch (provider app →
 * browser → QR); seasons + episodes (tv); cast; More like this. 403 age_restricted / 503 TMDB states.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { launchOffer, appInstalled, type InstallState } from "../lib/launch";
import { remPx } from "../lib/image";
import type { MediaTitleResponse, Offer, Person, TitleCard } from "../lib/media-types";
import { markWatched } from "../lib/progress-sync";
import { t } from "../i18n/messages";
import type { ScreenProps } from "../nav/ctx";
import { useScreenActive } from "../nav/Nav";
import { Empty, ErrorState, LoadingBlock, PrimaryButton, Row, SecondaryButton, SidePanel, useBackdrop } from "../ui";
import {
    cardKey, errorKind, fileBase, playLabel, previewTarget, resolveTarget, startPlayback, titleChips, trailerUrl, type PlayTarget,
} from "./home/media-ui";
import { HeroText, playFlip, QrBlock, TitlePoster } from "./home/widgets";
import { SeasonBlock } from "./title/Episodes";
import "./home/home.css";

type Load = { s: "loading" } | { s: "ok"; data: MediaTitleResponse } | { s: "error"; error: unknown } | { s: "unsupported" };
type Launch = { s: "idle" } | { s: "busy"; label: string } | { s: "info"; text: string } | { s: "error"; text: string } | { s: "qr"; url: string; text: string };

/** YouTube on Samsung Smart Hub. */
const YOUTUBE_TIZEN_APP = "111299001912";

function trailerOffer(url: string): Offer {
    return { providerId: 0, name: "YouTube", logo: null, type: "free", link: url, launch: { web: url, search: url, tizen: { appId: YOUTUBE_TIZEN_APP } } };
}

export function Title({ ctx, params }: ScreenProps<"title">) {
    const { kind, tmdbId, seed } = params;
    const [load, setLoad] = useState<Load>({ s: "loading" });
    const [rev, setRev] = useState(0);
    const [launch, setLaunch] = useState<Launch>({ s: "idle" });
    const [inList, setInList] = useState<boolean | null>(null);
    const [watched, setWatched] = useState(false);
    const [preferred, setPreferred] = useState<string | null>(null);
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [installed, setInstalled] = useState<Record<string, InstallState>>({});
    const posterRef = useRef<HTMLDivElement>(null);
    const backdrop = useBackdrop();
    const active = useScreenActive();

    useLayoutEffect(() => { playFlip(posterRef.current); }, []);

    useEffect(() => {
        let alive = true;
        if (rev > 0) ctx.media.invalidate();
        setLoad((l) => (l.s === "ok" ? l : { s: "loading" }));
        ctx.media.mediaTitle(kind, tmdbId)
            .then((data) => {
                if (!alive) return;
                if (!data) { setLoad({ s: "unsupported" }); return; }
                setLoad({ s: "ok", data });
                setInList(data.inWatchlist ?? false);
                setWatched(data.title.kind !== "tv" && data.progress.some((p) => p.completed && p.season === 0));
                const inst: Record<string, InstallState> = {};
                for (const o of data.availability.offers) {
                    const id = o.launch.tizen?.appId;
                    if (id && !(id in inst)) inst[id] = appInstalled(id);
                }
                setInstalled(inst);
            })
            .catch((error: unknown) => { if (alive) setLoad({ s: "error", error }); });
        return () => { alive = false; };
    }, [ctx.media, kind, tmdbId, rev]);

    const data = load.s === "ok" ? load.data : null;
    const det = data?.title;
    const card: TitleCard | undefined = det ?? seed;
    const backdropPath = card?.backdropPath ?? null;

    useEffect(() => {
        if (!active) return;
        backdrop.show(backdropPath ? ctx.media.image(backdropPath, "w1280") : null);
    }, [active, backdropPath, backdrop, ctx.media]);

    // Focus the primary action once details land (unless the user already moved).
    const focused = useRef(false);
    useEffect(() => {
        if (!data || focused.current) return;
        focused.current = true;
        requestAnimationFrame(() => {
            const el = document.querySelector<HTMLElement>('[data-nav-active="true"] [data-focus-key="title:play"], [data-nav-active="true"] [data-focus-key="title:offer:0"]');
            const act = document.activeElement as HTMLElement | null;
            if (el && (!act || act === document.body || !act.closest('[data-nav-active="true"]') || act.closest(".wt-head"))) el.focus();
        });
    }, [data]);

    const target: PlayTarget | null = useMemo(() => (data ? previewTarget(data, preferred) : null), [data, preferred]);
    const pl = playLabel(target);
    const trailer = trailerUrl(det);
    const files = data?.files ?? [];
    const curFile = target?.file ?? null;

    const play = useCallback(async (fromStart: boolean) => {
        if (!data) return;
        setLaunch({ s: "busy", label: t("common.loading") });
        try {
            const tg = await resolveTarget(ctx, data, preferred);
            if (!tg) { setLaunch({ s: "error", text: t("wh.notOnServer") }); return; }
            await startPlayback(ctx, tg, fromStart);
            setLaunch({ s: "idle" });
        } catch (e) {
            setLaunch({ s: "error", text: t("wh.playError", { message: (e as Error).message }) });
        }
    }, [ctx, data, preferred]);

    const open = useCallback(async (o: Offer, label: string) => {
        setLaunch({ s: "busy", label: t("title.launching", { name: label }) });
        try {
            const out = await launchOffer(o);
            if (out.via === "qr") setLaunch({ s: "qr", url: out.url, text: t("title.launchQr", { name: label }) });
            else if (out.via === "browser") setLaunch({ s: "info", text: t("title.launchedBrowser") });
            else setLaunch({ s: "idle" });
        } catch {
            setLaunch({ s: "qr", url: o.link ?? o.launch.web, text: t("title.launchQr", { name: label }) });
        }
    }, []);

    const toggleList = async () => {
        const next = !(inList ?? false);
        setInList(next);
        try {
            if (next) await ctx.media.watchlistAdd(kind, tmdbId);
            else await ctx.media.watchlistRemove(kind, tmdbId);
        } catch { setInList(!next); setLaunch({ s: "error", text: t("wh.listError") }); }
    };

    const mark = async () => {
        if (!data) return;
        const ref = target?.ref ?? { kind, tmdbId };
        const dur = (det?.runtime ?? 0) * 60;
        try {
            await markWatched(ctx.media, ref, dur);
            setWatched(true);
            setLaunch({ s: "info", text: ref.season ? t("wh.markedEp", { s: ref.season, e: ref.episode ?? 0 }) : t("title.watched") });
            setRev((r) => r + 1);
        } catch (e) { setLaunch({ s: "error", text: t("common.error", { message: (e as Error).message }) }); }
    };

    const more = useMemo(() => {
        if (!det) return [];
        const seen = new Set<string>([cardKey(det)]);
        const out: TitleCard[] = [];
        for (const c of [...det.recommendations, ...det.similar]) {
            const k = cardKey(c);
            if (seen.has(k)) continue;
            seen.add(k); out.push(c);
            if (out.length >= 30) break;
        }
        return out;
    }, [det]);

    const openTitle = (c: TitleCard) => ctx.nav.push({ name: "title", kind: c.kind, tmdbId: c.tmdbId, seed: c });

    // ─── Error states ────────────────────────────────────────────────────
    if (load.s === "error") {
        const k = errorKind(load.error);
        return (
            <div className="tv-screen" data-scroll="screen" data-testid="title-screen">
                {k === "age"
                    ? <Empty icon="kids" title={t("wh.ageTitle")} message={t("wh.ageMessage")} action={{ label: t("common.back"), icon: "chevronLeft", onClick: () => ctx.nav.pop() }} />
                    : <ErrorState title={t("wh.titleError")} message={k === "tmdb" ? t("wh.tmdbMissing") : String((load.error as Error)?.message ?? load.error)} onRetry={() => setRev((r) => r + 1)} />}
            </div>
        );
    }

    const poster = card?.posterPath ? ctx.media.image(card.posterPath, "w342") : null;
    const logo = det?.logoPath ? ctx.media.imageFor(det.logoPath, 640) : null;
    const genres = det?.genres.map((g) => g.name).filter(Boolean).join(" · ");
    const cast = (det?.cast ?? []).slice(0, 20);
    const seasons = det?.seasons ?? [];
    const firstSeason = data?.nextUp?.season || (seasons.find((s) => s.seasonNumber > 0)?.seasonNumber ?? seasons[0]?.seasonNumber ?? 1);
    const region = data?.availability ? ctx.media.homeCached()?.region ?? "RO" : "RO";

    return (
        <div className="tv-screen" data-scroll="screen" data-testid="title-screen">
            <div className="wt-head">
                <div ref={posterRef} className="wt-poster" aria-hidden="true">{poster && <img src={poster} alt="" />}</div>
                <div className="wt-info">
                    <HeroText logo={logo} name={card?.title ?? "…"} chips={titleChips(card, data)}
                        overview={det?.overview || seed?.overview}
                        extra={det?.tagline ? <p className="wh-tagline">{det.tagline}</p> : undefined} />
                    {genres && <p className="wh-genres">{genres}</p>}
                    {load.s === "loading" && <div style={{ width: "24rem" }}><LoadingBlock lines={2} /></div>}
                    {load.s === "unsupported" && <p className="wh-status">{t("home.mediaUnavailable")}</p>}
                    {data && (
                        <div className="wh-actions" data-focus-row="title:actions">
                            {target && <PrimaryButton icon="play" label={pl.label} sub={pl.sub} focusKey="title:play" testId="title-play" onClick={() => { void play(false); }} />}
                            {target && target.resumeSec > 0 && <SecondaryButton icon="refresh" label={t("wh.startOver")} focusKey="title:restart" onClick={() => { void play(true); }} />}
                            {trailer && <SecondaryButton icon="play" label={t("wh.trailer")} focusKey="title:trailer" testId="title-trailer" onClick={() => { void open(trailerOffer(trailer), t("wh.trailer")); }} />}
                            {files.length > 1 && <SecondaryButton icon="queue" label={t("wh.versions")} sub={curFile?.version?.label} focusKey="title:versions" onClick={() => setVersionsOpen(true)} />}
                            <SecondaryButton icon={inList ? "check" : "plus"} label={inList ? t("wh.inMyList") : t("wh.myList")} active={!!inList} focusKey="title:list" testId="title-list" onClick={() => { void toggleList(); }} />
                            <SecondaryButton icon="check" label={watched ? t("title.watched") : t("title.markWatched")} disabled={watched && kind !== "tv"} focusKey="title:watched" testId="mark-watched" onClick={() => { void mark(); }} />
                        </div>
                    )}
                    <div className={`wh-status${launch.s === "error" ? " is-error" : ""}`} data-testid="launch-status">
                        {launch.s === "busy" ? launch.label : launch.s === "info" || launch.s === "error" ? launch.text : ""}
                    </div>
                </div>
            </div>

            {launch.s === "qr" && <QrBlock url={launch.url} caption={launch.text} />}

            {data && kind === "tv" && seasons.length > 0 && (
                <SeasonBlock ctx={ctx} tmdbId={tmdbId} seasons={seasons} initial={firstSeason} showTitle={card?.title ?? ""}
                    onStatus={(m) => setLaunch(m ? { s: "error", text: m } : { s: "idle" })} />
            )}

            {data && (
                <section className="wt-section" data-testid="title-offers">
                    <h2 className="wt-section-title">{t("title.whereToWatch")}</h2>
                    {data.availability.offers.length === 0
                        ? <p className="wh-status">{t("title.noOffers", { region })}</p>
                        : (
                            <div className="wt-offers" data-focus-row="title:offers">
                                {data.availability.offers.map((o, i) => {
                                    const appId = o.launch.tizen?.appId;
                                    const state = appId ? installed[appId] ?? "unknown" : "missing";
                                    const logoUrl = ctx.media.image(o.logo, "w185");
                                    return (
                                        <button key={`${o.providerId}-${o.type}-${i}`} type="button" className={`wt-offer${state === "missing" ? " is-missing" : ""}`}
                                            data-focusable="" data-focus-key={`title:offer:${i}`} data-testid="provider-btn" data-app-id={appId ?? ""} data-installed={state}
                                            onClick={() => { void open(o, o.name); }}>
                                            {logoUrl && <img src={logoUrl} alt="" />}
                                            <span className="wt-offer-text">
                                                <span className="wt-offer-name">{o.name}</span>
                                                <span className="wt-offer-sub">
                                                    {t(`title.offer.${o.type}` as "title.offer.subscription")}
                                                    {appId ? ` · ${state === "installed" ? t("title.installed") : state === "missing" ? t("title.notInstalled") : ""}` : ""}
                                                </span>
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    {data.availability.attribution.length > 0 && <div className="wt-attrib">{t("title.attribution", { sources: data.availability.attribution.join(", ") })}</div>}
                </section>
            )}

            {cast.length > 0 && (
                <Row<Person> rowId="title:cast" title={t("wh.cast")} items={cast} itemKey={(p) => String(p.id)} itemWidthRem={6.5} heightRem={8.6}
                    renderItem={(p) => <CastItem ctx={ctx} person={p} />} />
            )}

            {more.length > 0 && (
                <Row<TitleCard> rowId="title:more" title={t("wh.moreLikeThis")} items={more} itemKey={cardKey}
                    renderItem={(c) => <TitlePoster c={c} media={ctx.media} prefix="title:more" onOpen={openTitle} />} />
            )}

            <SidePanel open={versionsOpen} title={t("wh.versions")} value={curFile?.serverFileId ?? null}
                items={files.map((f) => ({ id: f.serverFileId, label: f.version?.label || fileBase(f.path), sub: fileBase(f.path), icon: "movie" as const }))}
                onSelect={(id) => { setPreferred(id); setVersionsOpen(false); }} onClose={() => setVersionsOpen(false)} />
        </div>
    );
}

function CastItem({ ctx, person }: { ctx: ScreenProps<"title">["ctx"]; person: Person }) {
    const img = person.profilePath ? ctx.media.imageFor(person.profilePath, remPx(5.2)) : null;
    return (
        <button type="button" className="wt-cast" data-focusable="" data-focus-key={`title:cast:${person.id}`} aria-label={`${person.name}, ${person.role}`}
            onClick={() => ctx.nav.push({ name: "search", initial: person.name })}>
            <span className="wt-cast-img">{img ? <img src={img} alt="" loading="lazy" /> : person.name.slice(0, 1)}</span>
            <span className="wt-cast-name">{person.name}</span>
            {person.role && <span className="wt-cast-role">{person.role}</span>}
        </button>
    );
}
