import "@/components/mmo/live/live.css";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LivePlayer } from "@/components/mmo/live/live-player";
import { parseCatchup } from "@/components/mmo/live/live-logic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.live.player");
    return { title: `${t("title")} · MixAI` };
}

/** `/media/live/play/[channelId]` — WP16-41 full-screen live player (`?start=<ms>&dur=<min>` = catch-up). */
export default async function LivePlayPage({ params, searchParams }: {
    params: Promise<{ channelId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { channelId } = await params;
    const sp = await searchParams;
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] ?? null : v ?? null);
    const catchup = parseCatchup(one(sp.start), one(sp.dur));
    const id = decodeURIComponent(channelId);
    return <LivePlayer key={id} channelId={id} catchup={catchup} />;
}
