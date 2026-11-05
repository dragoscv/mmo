import "@/components/mmo/live/live.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ChannelsScreen } from "@/components/mmo/live/channels-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.live.channels");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/live` — WP16-41 channel list with now/next and a live preview. */
export default function LiveTvPage() {
    return <ChannelsScreen />;
}
