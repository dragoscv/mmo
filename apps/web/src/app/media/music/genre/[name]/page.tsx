import "@/components/mmo/music/music.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { GenreScreen } from "@/components/mmo/music/music-detail";
import { safeDecode } from "@/lib/mmo/music-core";

export async function generateMetadata({ params }: { params: Promise<{ name: string }> }): Promise<Metadata> {
    const [{ name }, t] = await Promise.all([params, getTranslations("mx.music")]);
    return { title: `${safeDecode(name)} · ${t("title")} · MixAI` };
}

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
    const { name } = await params;
    return <GenreScreen name={safeDecode(name)} />;
}
