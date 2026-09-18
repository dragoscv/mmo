import { CinemaSettingsPanel } from "@/components/settings/cinema-settings-panel";
import { WatchPrefsPanel } from "@/components/settings/watch-prefs-panel";
import { getWatchPrefs } from "@/actions/watch-prefs";

export const dynamic = "force-dynamic";

export default async function VideoSettingsPage() {
    const prefs = await getWatchPrefs();
    const tmdbConfigured = !!process.env.TMDB_API_KEY;
    const omdbConfigured = !!process.env.OMDB_API_KEY;
    const opensubsConfigured = !!process.env.OPENSUBTITLES_API_KEY;
    const discordConfigured = !!process.env.NEXT_PUBLIC_DISCORD_RPC_CLIENT_ID;

    return (
        <main className="p-4 sm:p-6 max-w-3xl space-y-6">
            <header>
                <h1 className="text-2xl font-bold">Video</h1>
                <p className="text-sm text-muted-foreground">Metadate, subtitrări, prezență Discord.</p>
            </header>

            <section className="rounded-lg border border-border bg-card p-4 space-y-2">
                <h2 className="font-semibold">Chei API metadate &amp; subtitrări</h2>
                <ul className="text-sm space-y-1">
                    <li>TMDB: {tmdbConfigured ? "✓ configurat" : "✗ lipsește TMDB_API_KEY"}</li>
                    <li>OMDb: {omdbConfigured ? "✓ configurat" : "✗ opțional, lipsește OMDB_API_KEY"}</li>
                    <li>OpenSubtitles: {opensubsConfigured ? "✓ configurat" : "✗ opțional, lipsește OPENSUBTITLES_API_KEY"}</li>
                    <li>Discord RPC: {discordConfigured ? "✓ configurat" : "✗ opțional, lipsește NEXT_PUBLIC_DISCORD_RPC_CLIENT_ID"}</li>
                </ul>
                <p className="text-xs text-muted-foreground">Setează cheile în <code>.env</code> și restart server.</p>
            </section>

            <section className="rounded-lg border border-border bg-card p-4 space-y-4">
                <header>
                    <h2 className="font-semibold">Cinema</h2>
                    <p className="text-xs text-muted-foreground">Comportament redare video, subtitrări, scurtături.</p>
                </header>
                <CinemaSettingsPanel />
            </section>

            <section className="rounded-lg border border-border bg-card p-0">
                <WatchPrefsPanel initial={prefs} />
            </section>
        </main>
    );
}
