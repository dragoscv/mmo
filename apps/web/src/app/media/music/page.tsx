import "@/components/mmo/music/music.css";
import type { Metadata } from "next";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { MusicHomeScreen } from "@/components/mmo/music/music-home";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.music");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/music` — music home, artists A–Z, albums (WP16-40). */
export default function MusicPage() {
    return <Suspense><MusicHomeScreen /></Suspense>;
}
