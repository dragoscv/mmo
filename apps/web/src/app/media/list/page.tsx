import "@/components/mmo/browse/browse.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ListScreen } from "@/components/mmo/browse/list-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.browse.list");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/list` — the active profile's watchlist on the MMO Server. */
export default function MediaListPage() {
    return <ListScreen />;
}
