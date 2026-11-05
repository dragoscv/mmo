import "@/components/mmo/music/music.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PlaylistScreen } from "@/components/mmo/music/music-detail";
import { safeDecode } from "@/lib/mmo/music-core";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.music");
    return { title: `${t("playlist.kicker")} · ${t("title")} · MixAI` };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    return <PlaylistScreen id={safeDecode(id)} />;
}
