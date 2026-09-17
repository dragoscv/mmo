"use client";

/**
 * Web binding for the shared @mmo/ui ThemeProvider.
 *
 * Preserves the legacy `useTheme()` shape ({ theme, setTheme, resolvedTheme })
 * for existing call sites, and keeps profile sync working: every change is
 * mirrored into the legacy `theme` localStorage key and dispatches
 * "mmo-preference-changed" (both done inside @mmo/ui's prefs-store), and the
 * new `mixai:` prefix is registered in lib/syncable-keys.ts.
 *
 * Pre-paint state is applied by /prehydrate.js (generated from
 * packages/design-tokens) which the root layout loads in <head>.
 */
import { startTransition, type ReactNode } from "react";
import { ThemeProvider as UiThemeProvider, useTheme, useThemePrefs, type ThemePrefs } from "@mmo/ui/theme";
import { setLocaleAction } from "@/actions/locale";
import type { AppLocale } from "@/i18n/locales";

export { useTheme, useThemePrefs };
export type { ThemePrefs };

export function ThemeProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: AppLocale }) {
    return (
        <UiThemeProvider
            initialPrefs={initialLocale ? { locale: initialLocale } : undefined}
            onChange={(prefs) => {
                // Locale lives in a cookie so the server can pick messages —
                // keep it in step when the user changes it from any surface.
                if (typeof document !== "undefined") {
                    const m = document.cookie.match(/(?:^|; )mmo-locale=(ro|en)/);
                    if (m?.[1] !== prefs.locale) startTransition(() => void setLocaleAction(prefs.locale));
                }
            }}
        >
            {children}
        </UiThemeProvider>
    );
}
