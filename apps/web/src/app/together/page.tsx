import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { GuestTogether } from "@/components/mmo/player/guest-together";

/**
 * `/together?server=<MMO Server base URL>&inv=<invite>` — public Watch Together guest page (WP16-39).
 * Encoded in the TV QR codes and the web invite link. No sign-in, no MmoProvider: the browser talks to the
 * MMO Server directly with the invite (hub `?inv=&name=`, media `?inv=`).
 */
export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("mx.player.guest");
    return { title: t("metaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default async function TogetherPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const sp = await searchParams;
    const one = (k: string): string | null => {
        const v = sp[k];
        return typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? null : null;
    };
    return <GuestTogether server={one("server")} invite={one("inv")?.slice(0, 256) ?? null} />;
}
