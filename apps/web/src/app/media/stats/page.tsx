import "@/components/mmo/browse/browse.css";
import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { StatsScreen } from "@/components/mmo/browse/stats-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.browse.stats");
    return { title: `${t("pageTitle")} · MixAI` };
}

/** `/media/stats?year=` — year in review for the active profile. */
export default function MediaStatsPage() {
    return (
        <Suspense fallback={null}>
            <StatsScreen />
        </Suspense>
    );
}
