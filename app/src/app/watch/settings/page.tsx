import type { Metadata } from "next";
import { ThemePicker } from "../_theme/theme-picker";
import { BackfillButton } from "./_backfill-button";
import { WatchPrefsPanel } from "@/components/settings/watch-prefs-panel";
import { getWatchPrefs } from "@/actions/watch-prefs";

export const metadata: Metadata = { title: "Settings" };

export const dynamic = "force-dynamic";

export default async function WatchSettingsPage() {
    const prefs = await getWatchPrefs();
    return (
        <div className="watch-settings">
            <h2>Appearance</h2>
            <p className="watch-settings-blurb">
                Pick a visual style for the Watch surface. Changes apply instantly and persist on this device.
            </p>
            <ThemePicker />

            <h2>Metadata</h2>
            <p className="watch-settings-blurb">
                When a scan adds a movie or series we automatically look it up on TMDB for posters, overviews,
                cast, ratings and trailer. Use this button to re-run the lookup for items still missing data.
            </p>
            <BackfillButton />

            <WatchPrefsPanel initial={prefs} />
        </div>
    );
}
