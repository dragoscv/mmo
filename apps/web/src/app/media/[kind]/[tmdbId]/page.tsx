import "@/components/mmo/browse/browse.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { getMediaTitle } from "@/actions/media";
import { TitleScreen, TitleSkeleton } from "@/components/mmo/browse/title-screen";
import type { MediaKind } from "@/lib/mmo/media-types";

type Params = Promise<{ kind: string; tmdbId: string }>;

const isKind = (k: string): k is MediaKind => k === "movie" || k === "tv";

function parseParams(kind: string, id: string): { kind: MediaKind; tmdbId: number } | null {
    const tmdbId = Number(id);
    if (!isKind(kind) || !Number.isInteger(tmdbId) || tmdbId <= 0) return null;
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
 * `/media/[kind]/[tmdbId]` — WP16 title page, rendered client-side against the user's MMO Server
 * (`/media/title`). `?play=1` forwards to `/media/play/...`.
 */
export default async function MediaTitlePage({ params }: { params: Params }) {
    const raw = await params;
    const p = parseParams(raw.kind, raw.tmdbId);
    if (!p) notFound();
    const t = await getTranslations("mx.browse.title");
    return (
        <Suspense fallback={<TitleSkeleton label={t("loading")} />}>
            <TitleScreen key={`${p.kind}:${p.tmdbId}`} kind={p.kind} tmdbId={p.tmdbId} />
        </Suspense>
    );
}
