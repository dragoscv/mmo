/**
 * next-intl request config — picks the locale from the `mmo-locale` cookie
 * and falls back to Romanian (the project's primary market).
 *
 * No `[locale]` segment in the URL: the app stays single-tenant per browser
 * and switches via a small cookie-toggle in Settings. This keeps every
 * existing route untouched while still giving us proper i18n message
 * separation and ICU formatting.
 */

import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, isAppLocale, type AppLocale } from "./locales";

export { SUPPORTED_LOCALES, DEFAULT_LOCALE, isAppLocale, type AppLocale };

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const raw = cookieStore.get("mmo-locale")?.value ?? DEFAULT_LOCALE;
    const locale: AppLocale = isAppLocale(raw) ? raw : DEFAULT_LOCALE;
    const messages = (await import(`../../messages/${locale}.json`)).default;
    return { locale, messages };
});
