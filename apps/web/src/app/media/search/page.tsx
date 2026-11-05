import "@/components/mmo/browse/browse.css";
import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { GridSkeleton } from "@/components/mmo/browse/common";
import { SearchScreen } from "@/components/mmo/browse/search-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.browse.search");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/search?q=` — WP16-38: library matches first, then TMDB results from the MMO Server. */
export default function MediaSearchPage() {
    return (
        <Suspense fallback={<GridSkeleton count={12} />}>
            <SearchScreen />
        </Suspense>
    );
}
