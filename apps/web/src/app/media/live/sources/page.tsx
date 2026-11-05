import "@/components/mmo/live/live.css";
import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { SourcesScreen } from "@/components/mmo/live/sources-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.live.sources");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/live/sources` — WP16-41 source settings + channel management (`?add=1` opens the form). */
export default function LiveSourcesPage() {
    return (
        <Suspense>
            <SourcesScreen />
        </Suspense>
    );
}
