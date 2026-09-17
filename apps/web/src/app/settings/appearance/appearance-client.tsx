"use client";

import { ThemePreview, ThemeSettings } from "@mmo/ui";

/**
 * Settings › Appearance & language. All state lives in the shared
 * ThemeProvider (`mixai:prefs:v1`), synced per viewing profile and applied
 * before first paint by /prehydrate.js. Locale changes also update the
 * `mmo-locale` cookie via the ThemeProvider's onChange hook.
 */
export function AppearanceClient() {
    return (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
            <ThemeSettings allowArtworkAccent />
            <div className="xl:sticky xl:top-6">
                <ThemePreview />
            </div>
        </div>
    );
}
