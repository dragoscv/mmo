import "@/components/mmo/live/live.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RecordingsScreen } from "@/components/mmo/live/recordings-screen";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.live.recordings");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/live/recordings` — WP16-41 DVR recordings + series rules. */
export default function LiveRecordingsPage() {
    return <RecordingsScreen />;
}
