import "@/components/mmo/music/music.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { NowPlayingScreen } from "@/components/mmo/music/now-playing";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.music.player");
    return { title: `${t("nowPlaying")} · MixAI` };
}

export default function MusicNowPlayingPage() {
    return <NowPlayingScreen />;
}
