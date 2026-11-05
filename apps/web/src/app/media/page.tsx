import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { MediaHomeScreen } from "@/components/mmo/home-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.shell.nav");
    return { title: `${t("home")} · MixAI` };
}

/** `/media` — WP16 Home: cache-first from localStorage (< 1 s), revalidated against `/media/etag`. */
export default function MediaHomePage() {
    return <MediaHomeScreen />;
}
