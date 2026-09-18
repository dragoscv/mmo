import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CinemaSettingsPanel } from "@/components/settings/cinema-settings-panel";
import { MediaPrefsPanel } from "@/components/settings/media-prefs-panel";
import { WatchPrefsPanel } from "@/components/settings/watch-prefs-panel";
import { getWatchPrefs } from "@/actions/watch-prefs";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations("nav");
    return { title: t("settings-media") };
}

/**
 * Settings › Media (WP11-06). Region / providers / Media Home toggles on
 * top, then the former Settings › Video content (API keys, Cinema,
 * subtitle prefs) merged below. `/settings/video` redirects here.
 */
export default async function MediaSettingsPage() {
    const [t, prefs] = await Promise.all([getTranslations("settings.media"), getWatchPrefs()]);
    const curatorAvailable = !!(process.env.CODAI_API_KEY || process.env.CODAI_APP_TOKEN);
    const keys = [
        { name: "TMDB", ok: !!process.env.TMDB_API_KEY, env: "TMDB_API_KEY", optional: false },
        { name: "OMDb", ok: !!process.env.OMDB_API_KEY, env: "OMDB_API_KEY", optional: true },
        { name: "OpenSubtitles", ok: !!process.env.OPENSUBTITLES_API_KEY, env: "OPENSUBTITLES_API_KEY", optional: true },
        { name: "Discord RPC", ok: !!process.env.NEXT_PUBLIC_DISCORD_RPC_CLIENT_ID, env: "NEXT_PUBLIC_DISCORD_RPC_CLIENT_ID", optional: true },
    ];

    return (
        <main className="space-y-6">
            <header>
                <h1 className="font-heading text-2xl font-semibold tracking-tight">{t("title")}</h1>
                <p className="text-sm text-muted-foreground">{t("description")}</p>
            </header>

            <MediaPrefsPanel initial={prefs} curatorAvailable={curatorAvailable} />

            <section className="rounded-lg border border-border bg-card p-4 space-y-2">
                <h2 className="font-semibold">{t("keys.title")}</h2>
                <ul className="text-sm space-y-1">
                    {keys.map((k) => (
                        <li key={k.env}>
                            {k.name}: {k.ok ? t("keys.configured") : t(k.optional ? "keys.missingOptional" : "keys.missing", { env: k.env })}
                        </li>
                    ))}
                </ul>
                <p className="text-xs text-muted-foreground">{t("keys.hint")}</p>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 space-y-4">
                <header>
                    <h2 className="font-semibold">{t("cinema.title")}</h2>
                    <p className="text-xs text-muted-foreground">{t("cinema.description")}</p>
                </header>
                <CinemaSettingsPanel />
            </section>

            <section className="rounded-lg border border-border bg-card p-0">
                <WatchPrefsPanel initial={prefs} />
            </section>
        </main>
    );
}
