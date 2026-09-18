import { useCallback, type ReactNode } from "react";
import { UiI18nProvider, format, useThemePrefs, type UiLocale, type UiMessageKey } from "@mmo/ui";
import { messages, type MessageKey } from "./messages";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function resolveLocale(locale: string): UiLocale {
    return locale in messages ? (locale as UiLocale) : "en";
}

export function translate(locale: UiLocale, key: MessageKey, vars?: Record<string, string | number>): string {
    const table = messages[locale] ?? messages.en;
    return format(table[key] ?? messages.en[key] ?? key, vars);
}

/** Companion translate hook. Language follows `prefs.locale` from the shared ThemeProvider. */
export function useT(): Translate {
    const { prefs } = useThemePrefs();
    const locale = resolveLocale(prefs.locale);
    return useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);
}

/**
 * Feeds the merged catalogue to @mmo/ui components (EmptyState, ThemeSettings,
 * DataTable…) so their built-in strings and ours come from one table, and
 * mirrors the locale to `<html lang>`.
 */
export function CompanionI18nProvider({ children }: { children: ReactNode }) {
    const t = useT();
    const { prefs } = useThemePrefs();
    if (typeof document !== "undefined") {
        const lang = resolveLocale(prefs.locale);
        if (document.documentElement.lang !== lang) document.documentElement.lang = lang;
    }
    const uiT = useCallback((key: UiMessageKey, vars?: Record<string, string | number>) => t(key, vars), [t]);
    return <UiI18nProvider t={uiT}>{children}</UiI18nProvider>;
}
