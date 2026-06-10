/**
 * Pure locale constants — safe to import from BOTH server and client
 * components. Kept separate from `request.ts` so `locale-switcher.tsx`
 * (a client component) doesn't transitively pull `next/headers` into
 * the client bundle, which Next 16 rejects with a build error.
 */

export const SUPPORTED_LOCALES = ["ro", "en"] as const;
export type AppLocale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: AppLocale = "ro";

export function isAppLocale(value: string): value is AppLocale {
    return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
