/**
 * i18next (RO default, EN). The locale follows the shared theme prefs (`mixai:prefs:v1`.locale), so the
 * language picker in Settings and @mmo/ui's ThemeSettings stay in one place.
 */
import i18n from "i18next";
import { useEffect, type ReactNode } from "react";
import { I18nextProvider, initReactI18next, useTranslation } from "react-i18next";
import { useThemePrefs } from "@mmo/ui/theme";
import { UiI18nProvider, translate as uiTranslate, uiMessages, type UiLocale, type UiMessageKey } from "@mmo/ui/i18n";
import en from "./en.json";
import ro from "./ro.json";

void i18n.use(initReactI18next).init({
    resources: { en: { translation: en }, ro: { translation: ro } },
    lng: document.documentElement.lang === "en" ? "en" : "ro",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
});

export { i18n };

function LocaleSync() {
    const { prefs } = useThemePrefs();
    useEffect(() => {
        const lng = prefs.locale === "en" ? "en" : "ro";
        if (i18n.language !== lng) void i18n.changeLanguage(lng);
    }, [prefs.locale]);
    return null;
}

function UiBridge({ children }: { children: ReactNode }) {
    const { prefs } = useThemePrefs();
    const locale = (prefs.locale in uiMessages ? prefs.locale : "en") as UiLocale;
    const t = (key: UiMessageKey, vars?: Record<string, string | number>) => uiTranslate(locale, key, vars);
    return <UiI18nProvider t={t}>{children}</UiI18nProvider>;
}

export function AppI18nProvider({ children }: { children: ReactNode }) {
    return (
        <I18nextProvider i18n={i18n}>
            <LocaleSync />
            <UiBridge>{children}</UiBridge>
        </I18nextProvider>
    );
}

export const useT = () => useTranslation().t;
