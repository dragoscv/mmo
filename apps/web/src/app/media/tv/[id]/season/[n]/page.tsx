import "@/components/mmo/browse/browse.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { SeasonScreen } from "@/components/mmo/browse/season-screen";

type Params = Promise<{ id: string; n: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { n } = await params;
    const t = await getTranslations("mx.browse.season");
    return { title: `${t("seasonN", { n: Number(n) || 0 })} · MixAI` };
}

/** `/media/tv/{id}/season/{n}` — every episode of one season with stills, progress and play links. */
export default async function MediaSeasonPage({ params }: { params: Params }) {
    const { id, n } = await params;
    const tmdbId = Number(id);
    const season = Number(n);
    if (!Number.isInteger(tmdbId) || tmdbId <= 0 || !Number.isInteger(season) || season < 0) notFound();
    return <SeasonScreen key={`${tmdbId}:${season}`} tmdbId={tmdbId} season={season} />;
}
