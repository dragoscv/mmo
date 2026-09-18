import "../../media-home.css";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge, Page } from "@mmo/ui";
import { auth } from "@/auth";
import { getLocalTitleState, getMediaTitle } from "@/actions/media";
import { notSignedInFor } from "@/components/empty-state-server";
import { MediaCard } from "@/components/media/media-card";
import { MediaRow } from "@/components/media/media-row";
import { ProviderOffers } from "@/components/media/provider-offers";
import { ServerNotices } from "@/components/media/server-notices";
import { TitleActions } from "@/components/media/title-actions";
import { TitleSources } from "@/components/media/title-sources";
import { tmdbImg } from "@/lib/media/normalize";
import type { MediaKind } from "@/lib/media/types";

export const dynamic = "force-dynamic";

type Params = Promise<{ kind: string; tmdbId: string }>;

const isKind = (k: string): k is MediaKind => k === "movie" || k === "tv";

function parseParams(kind: string, id: string): { kind: MediaKind; tmdbId: number } | null {
    const tmdbId = parseInt(id, 10);
    if (!isKind(kind) || !Number.isFinite(tmdbId) || tmdbId <= 0) return null;
    return { kind, tmdbId };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { kind, tmdbId } = await params;
    const p = parseParams(kind, tmdbId);
    if (!p) return { title: "MixAI" };
    const data = await getMediaTitle(p.kind, p.tmdbId).catch(() => null);
    const title = data?.title.title;
    return {
        title: title ? `${title}${data?.title.year ? ` (${data.title.year})` : ""} · MixAI` : "MixAI",
        description: data?.title.overview ?? undefined,
    };
}

/**
 * `/media/[kind]/[tmdbId]` — unified title page (WP11-04). Details from the
 * first MMO Server that answered, local files from every server, streaming
 * offers with deep links, web-side actions (watchlist / watched / hide).
 */
export default async function MediaTitlePage({ params }: { params: Params }) {
    const raw = await params;
    const p = parseParams(raw.kind, raw.tmdbId);
    if (!p) notFound();

    const session = await auth();
    if (!session?.user?.id) return notSignedInFor("watch");

    const [t, locale, data, state] = await Promise.all([
        getTranslations("media"),
        getLocale(),
        getMediaTitle(p.kind, p.tmdbId).catch(() => null),
        getLocalTitleState(p.kind, p.tmdbId).catch(() => ({ localId: null, inWatchlist: false, watched: false, hidden: false })),
    ]);

    if (!data) {
        return (
            <Page className="media-title">
                <h1 className="font-heading text-2xl font-semibold">{t("unavailable.title")}</h1>
                <p className="mt-2 text-sm text-muted-foreground">{t("unavailable.description")}</p>
            </Page>
        );
    }

    const { title, sources, availability, progress, errors } = data;
    const backdrop = tmdbImg(title.backdrop, "w1280");
    const poster = tmdbImg(title.poster, "w500");
    const logo = tmdbImg(title.logo, "w500");
    const meta = [
        title.year,
        title.certification,
        title.runtime ? t("meta.runtime", { min: title.runtime }) : null,
        title.numberOfSeasons ? t("meta.seasons", { count: title.numberOfSeasons }) : null,
        title.rating ? `★ ${title.rating.toFixed(1)}` : null,
    ].filter(Boolean);
    const similar = (title.similar.length ? title.similar : title.recommendations).slice(0, 24);

    return (
        <Page width="full" bleed className="media-title">
            <section className="media-title-hero" aria-hidden>
                {backdrop ? <Image src={backdrop} alt="" fill priority sizes="100vw" className="media-hero-bg" /> : null}
                <div className="media-hero-scrim" />
            </section>

            <div className="content-xl media-title-body px-4 sm:px-6 lg:px-8">
                <div className="hidden md:block">
                    {poster ? (
                        <Image src={poster} alt={title.title} width={352} height={528} className="media-title-poster" />
                    ) : (
                        <div className="media-title-poster" />
                    )}
                </div>

                <div className="flex min-w-0 flex-col gap-6">
                    <header className="flex flex-col gap-3">
                        {logo ? (
                            <>
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={logo} alt="" className="media-hero-logo" />
                                <h1 className="sr-only">{title.title}</h1>
                            </>
                        ) : (
                            <h1 className="media-hero-title">{title.title}</h1>
                        )}
                        {title.tagline ? <p className="text-sm italic text-muted-foreground">{title.tagline}</p> : null}
                        <div className="media-hero-meta">
                            {meta.map((m, i) => <span key={i}>{i > 0 ? "· " : ""}{m}</span>)}
                        </div>
                        {title.genres.length ? (
                            <div className="flex flex-wrap gap-1.5">
                                {title.genres.map((g) => <Badge key={g} variant="outline">{g}</Badge>)}
                            </div>
                        ) : null}
                        {title.overview ? <p className="max-w-prose text-pretty">{title.overview}</p> : null}
                        <TitleActions kind={p.kind} tmdbId={p.tmdbId} state={state} />
                    </header>

                    <ServerNotices errors={errors} />
                    <TitleSources sources={sources} progress={progress} />
                    <ProviderOffers availability={availability} preferred={data.preferredProviders} />

                    {title.trailerKey ? (
                        <section className="media-title-section" aria-labelledby="media-trailer-title">
                            <h2 id="media-trailer-title">{t("trailer")}</h2>
                            <iframe
                                className="media-trailer"
                                src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(title.trailerKey)}?rel=0&hl=${locale}`}
                                title={t("trailerFor", { title: title.title })}
                                loading="lazy"
                                allow="accelerometer; encrypted-media; picture-in-picture"
                                allowFullScreen
                                referrerPolicy="strict-origin-when-cross-origin"
                            />
                        </section>
                    ) : null}

                    {title.cast.length ? (
                        <section className="media-title-section" aria-labelledby="media-cast-title">
                            <h2 id="media-cast-title">{t("cast")}</h2>
                            <ul className="media-cast" role="list">
                                {title.cast.map((c) => {
                                    const img = tmdbImg(c.profilePath, "w185");
                                    return (
                                        <li key={`${c.id}-${c.role}`} className="media-cast-item">
                                            {img ? (
                                                // eslint-disable-next-line @next/next/no-img-element
                                                <img src={img} alt="" loading="lazy" width={88} height={88} />
                                            ) : (
                                                <span className="media-cast-avatar" aria-hidden />
                                            )}
                                            <span className="font-medium">{c.name}</span>
                                            <span className="text-muted-foreground">{c.role}</span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ) : null}

                    {similar.length ? (
                        <MediaRow id="row-similar" title={t("similar")}>
                            {similar.map((it) => <MediaCard key={`${it.kind}:${it.tmdbId}`} item={it} />)}
                        </MediaRow>
                    ) : null}
                </div>
            </div>
        </Page>
    );
}
