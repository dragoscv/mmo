import "@/components/mmo/browse/browse.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CollectionsScreen } from "@/components/mmo/browse/collections-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.browse.collections");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/collections` — franchise rows (`collection:<id>`) the server builds on Home. */
export default function MediaCollectionsPage() {
    return <CollectionsScreen />;
}
