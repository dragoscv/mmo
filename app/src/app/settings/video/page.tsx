import { getCompanionVideoFlags } from "@/lib/companion-video";

export const dynamic = "force-dynamic";

export default async function VideoSettingsPage() {
    const flags = await getCompanionVideoFlags();
    const tmdbConfigured = !!process.env.TMDB_API_KEY;
    const omdbConfigured = !!process.env.OMDB_API_KEY;
    const opensubsConfigured = !!process.env.OPENSUBTITLES_API_KEY;
    const discordConfigured = !!process.env.NEXT_PUBLIC_DISCORD_RPC_CLIENT_ID;

    return (
        <main className="p-4 sm:p-6 max-w-3xl space-y-6">
            <header>
                <h1 className="text-2xl font-bold">Video</h1>
                <p className="text-sm text-muted-foreground">Surse externe, metadate, prezență Discord.</p>
            </header>

            <section className="rounded-lg border border-border bg-card p-4 space-y-3">
                <h2 className="font-semibold">Embed extern (vidsrc &amp; co.)</h2>
                <p className="text-sm text-muted-foreground">
                    {flags?.vidsrcEnabled
                        ? "ACTIV — butonul „Play” pe filme apare cu sursă vidsrc dacă lipsește fișierul local."
                        : "DEZACTIVAT — playerul folosește doar fișiere locale scanate de companion."}
                </p>
                <p className="text-xs text-muted-foreground">
                    Comutator pe companion (Electron): <code>video.externalEmbed.vidsrc.enabled</code>. Modifică-l din UI companion.
                </p>
            </section>

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
        </main>
    );
}
