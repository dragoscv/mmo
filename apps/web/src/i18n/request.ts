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

/** Must match the files in `messages/wp16/` (checked by `scripts/i18n-parity.mjs`). */
export const WP16_AREAS = ["shell", "profiles", "browse", "player", "music", "live", "offline", "account"] as const;

export default getRequestConfig(async () => {
    const cookieStore = await cookies();
    const raw = cookieStore.get("mmo-locale")?.value ?? DEFAULT_LOCALE;
    const locale: AppLocale = isAppLocale(raw) ? raw : DEFAULT_LOCALE;
    const base = (await import(`../../messages/${locale}.json`)).default;
    // WP16 media surfaces keep their strings in per-area files (`messages/wp16/<area>.<locale>.json`,
    // namespace `mx.<area>`) so screens can be built in parallel without editing one giant file.
    const mx: Record<string, unknown> = {};
    for (const area of WP16_AREAS) {
        mx[area] = (await import(`../../messages/wp16/${area}.${locale}.json`)).default;
    }
    return { locale, messages: { ...base, mx } };
});
