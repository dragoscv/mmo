import "@/components/mmo/live/live.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { GuideScreen } from "@/components/mmo/live/guide-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.live.guide");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/live/guide` — WP16-41 EPG grid. */
export default function LiveGuidePage() {
    return <GuideScreen />;
}
