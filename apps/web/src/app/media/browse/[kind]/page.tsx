import "@/components/mmo/browse/browse.css";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { GridSkeleton } from "@/components/mmo/browse/common";
import { LibraryScreen } from "@/components/mmo/browse/library-screen";

type Params = Promise<{ kind: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
    const { kind } = await params;
    const t = await getTranslations("mx.browse.library");
    return { title: `${kind === "tv" ? t("shows") : t("movies")} · MixAI` };
}

/** `/media/browse/{movie|tv}` — WP16-38 library grid (sort, genres, unwatched, A–Z) from the MMO Server index. */
export default async function MediaBrowsePage({ params }: { params: Params }) {
    const { kind } = await params;
    if (kind !== "movie" && kind !== "tv") notFound();
    return (
        <Suspense fallback={<GridSkeleton />}>
            <LibraryScreen key={kind} kind={kind} />
        </Suspense>
    );
}
