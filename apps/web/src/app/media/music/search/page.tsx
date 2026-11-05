import "@/components/mmo/music/music.css";
import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { MusicSearchScreen } from "@/components/mmo/music/music-detail";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.music");
    return { title: `${t("search.title")} · ${t("title")} · MixAI` };
}

export default function MusicSearchPage() {
    return <Suspense><MusicSearchScreen /></Suspense>;
}
