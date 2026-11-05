import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PlayRoute } from "@/components/mmo/player/play-route";
import { intParam } from "@/components/mmo/player/model";

/**
 * `/media/play/<movie|tv>/<tmdbId>?file=&s=&e=&t=&room=` — full-screen cinematic player (WP16-39).
 * The media shell renders `/media/play/*` bare (no top bar) but still behind the profile gate.
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.player.route");
    return { title: t("metaTitle"), robots: { index: false } };
}

export default async function PlayPage({ params, searchParams }: {
    params: Promise<{ kind: string; tmdbId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { kind, tmdbId } = await params;
    const sp = await searchParams;
    const one = (k: string): string | null => {
        const v = sp[k];
        return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? null : null;
    };
    const id = intParam(tmdbId);
    if ((kind !== "movie" && kind !== "tv") || !id) notFound();
    const file = one("file");
    return (
        <PlayRoute
            kind={kind}
            tmdbId={id}
            file={file && /^[A-Za-z0-9_-]{1,128}$/.test(file) ? file : null}
            season={intParam(one("s"))}
            episode={intParam(one("e"))}
            startSec={intParam(one("t"))}
            room={one("room")?.slice(0, 64) ?? null}
        />
    );
}
