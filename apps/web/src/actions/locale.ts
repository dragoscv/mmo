"use server";

/**
 * Locale switcher — sets the `mmo-locale` cookie that
 * `src/i18n/request.ts` reads on every request. Call from a small
 * client component in Settings (or anywhere a language picker lives).
 */

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type AppLocale } from "@/i18n/locales";

export async function setLocaleAction(locale: string): Promise<{ ok: boolean; locale: AppLocale }> {
    const next: AppLocale = (SUPPORTED_LOCALES as readonly string[]).includes(locale)
        ? (locale as AppLocale)
        : DEFAULT_LOCALE;
    const jar = await cookies();
    jar.set("mmo-locale", next, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365, // 1y
        sameSite: "lax",
    });
    // Force every server-rendered page to re-evaluate with the new locale.
    revalidatePath("/", "layout");
    return { ok: true, locale: next };
}
