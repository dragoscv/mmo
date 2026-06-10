import "./cinematic.css";
import "./tv-mode.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { LibraryEventsListener } from "@/components/video/library-events-listener";
import { TvModeProbe } from "@/components/video/tv-mode-probe";
import { WatchPrefsHydrator } from "@/components/video/watch-prefs-hydrator";
import { WatchThemeProvider } from "./_theme/watch-theme-provider";
import { WatchTopBar } from "@/components/video/watch-top-bar";
import { getWatchPrefs } from "@/actions/watch-prefs";

export const metadata: Metadata = {
    title: { template: "%s · Watch · MMO", default: "Watch · MMO" },
    description: "Filme, seriale și alte clipuri din biblioteca ta locală.",
};

export default async function WatchLayout({ children }: { children: ReactNode }) {
    const prefs = await getWatchPrefs().catch(() => null);
    return (
        <>
            {/* Hoisted by React 19 into <head>; sets data-watch-theme on
                <html> before first paint so a non-default theme has no
                FOUC after a reload. Served from /public to avoid the
                inline-script-in-React-component warning. */}
            <script src="/watch-theme-prehydrate.js" async />
            <WatchThemeProvider>
                <div className="watch-shell" data-watch-theme="netflix">
                    <LibraryEventsListener />
                    <TvModeProbe />
                    <WatchPrefsHydrator />
                    <WatchTopBar initialLocalOnly={prefs?.localOnly ?? false} />
                    {children}
                </div>
            </WatchThemeProvider>
        </>
    );
}
