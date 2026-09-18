/**
 * Tiny `t()` for MixAI DJ. Resolves app strings (./messages) first, then the
 * shared @mmo/ui catalogue, then falls back to English, then to the key.
 * Locale comes from the shared theme prefs (`prefs.locale`, RO default).
 */
import { useCallback, type ReactNode } from "react";
import { useThemePrefs } from "@mmo/ui/theme";
import { UiI18nProvider, format, uiMessages, type UiLocale, type UiMessageKey } from "@mmo/ui/i18n";
import { appMessages, type AppMessageKey } from "./messages";

export type MessageKey = AppMessageKey | UiMessageKey;
export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function lookup(locale: UiLocale, key: string): string | undefined {
    const app = appMessages[locale] as Record<string, string>;
    const ui = uiMessages[locale] as Record<string, string>;
    return app[key] ?? ui[key];
}

export function translate(locale: UiLocale, key: MessageKey, vars?: Record<string, string | number>): string {
    const text = lookup(locale, key) ?? lookup("en", key) ?? key;
    return format(text, vars);
}

/** Current locale from theme prefs, narrowed to a supported catalogue. */
export function useLocale(): UiLocale {
    const { prefs } = useThemePrefs();
    return (prefs.locale in appMessages ? prefs.locale : "en") as UiLocale;
}

export function useT(): Translate {
    const locale = useLocale();
    return useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);
}

/**
 * Provides the app `t()` to @mmo/ui components (they call `useUiT()`), so shared
 * component strings can be overridden from the app catalogue if needed.
 */
export function AppI18nProvider({ children }: { children: ReactNode }) {
    const t = useT();
    return <UiI18nProvider t={t}>{children}</UiI18nProvider>;
}
