"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useThemePrefs } from "../theme/theme-provider.tsx";
import { uiMessages, type UiLocale, type UiMessageKey } from "./messages.ts";

export { uiMessages, type UiLocale, type UiMessageKey };

export type UiTranslate = (key: UiMessageKey, vars?: Record<string, string | number>) => string;

/**
 * Apps that already have an i18n layer (next-intl) can supply their own
 * translate function so component strings come from the app catalogue.
 */
const UiI18nContext = createContext<UiTranslate | null>(null);

export function UiI18nProvider({ t, children }: { t: UiTranslate; children: ReactNode }) {
  return <UiI18nContext.Provider value={t}>{children}</UiI18nContext.Provider>;
}

export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
}

export function translate(locale: UiLocale, key: UiMessageKey, vars?: Record<string, string | number>): string {
  const table = uiMessages[locale] ?? uiMessages.en;
  return format((table as Record<string, string>)[key] ?? uiMessages.en[key] ?? key, vars);
}

/** Component-internal hook: app-provided `t` if any, else built-in messages for the current locale. */
export function useUiT(): UiTranslate {
  const external = useContext(UiI18nContext);
  const { prefs } = useThemePrefs();
  const locale = (prefs.locale in uiMessages ? prefs.locale : "en") as UiLocale;
  return useCallback<UiTranslate>((key, vars) => (external ? external(key, vars) : translate(locale, key, vars)), [external, locale]);
}
