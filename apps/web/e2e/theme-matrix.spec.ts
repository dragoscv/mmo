import { test, expect, type Page } from "@playwright/test";

/**
 * WP8-02 — theme × locale × width matrix.
 *
 * Width comes from the Playwright project (`w390`/`w768`/`w1440`/`w3440` in
 * playwright.config.ts); this spec multiplies it by light/dark × ro/en on the
 * three shell-bearing routes. For every cell it seeds the prefs blob the
 * ThemeProvider reads (`mixai:prefs:v1`) plus the next-intl locale cookie,
 * loads the page and asserts:
 *   - `<html data-mode>` matches the requested mode (prehydrate.js + provider)
 *   - `<html lang>` matches the requested locale (server messages + provider)
 *   - no horizontal overflow (`scrollWidth <= innerWidth`) — the ultra-wide and
 *     phone breakpoints are where the shell has historically leaked.
 * A full-page screenshot per cell lands in test-results/theme-matrix/ for
 * eyeballing / an external diff tool.
 */

const MODES = ["light", "dark"] as const;
const LOCALES = ["ro", "en"] as const;
const ROUTES = ["/", "/library", "/settings/appearance"] as const;
const PREFS_KEY = "mixai:prefs:v1";
const LOCALE_COOKIE = "mmo-locale";

type Mode = (typeof MODES)[number];
type Locale = (typeof LOCALES)[number];

async function seed(page: Page, baseURL: string, mode: Mode, locale: Locale) {
    await page.context().addCookies([{ name: LOCALE_COOKIE, value: locale, url: baseURL }]);
    await page.addInitScript(
        ([key, m, l]) => {
            const prev = (() => {
                try {
                    return JSON.parse(localStorage.getItem(key as string) ?? "{}") as Record<string, unknown>;
                } catch {
                    return {};
                }
            })();
            localStorage.setItem(key as string, JSON.stringify({ ...prev, mode: m, locale: l }));
        },
        [PREFS_KEY, mode, locale] as const,
    );
}

for (const mode of MODES) {
    for (const locale of LOCALES) {
        for (const route of ROUTES) {
            test(`${route} · ${mode} · ${locale}`, async ({ page, baseURL }, testInfo) => {
                const width = page.viewportSize()?.width ?? 0;
                expect(width, "spec must run under a w<width> project").toBeGreaterThan(0);

                const consoleErrors: string[] = [];
                page.on("pageerror", (err) => consoleErrors.push(err.message));

                await seed(page, baseURL!, mode, locale);
                const response = await page.goto(route);
                expect(response, `response for ${route}`).not.toBeNull();
                expect(response!.status(), `${route} status`).toBeLessThan(400);
                // Second load so BOTH the cookie (server render) and the seeded
                // localStorage (client provider) are in effect from first paint.
                await page.reload();
                await page.waitForLoadState("networkidle");

                const html = page.locator("html");
                await expect(html).toHaveAttribute("data-mode", mode);
                await expect(html).toHaveAttribute("lang", locale);
                await expect(html).toHaveClass(new RegExp(`\\b${mode}\\b`));

                const overflow = await page.evaluate(() => ({
                    scrollWidth: document.documentElement.scrollWidth,
                    innerWidth: window.innerWidth,
                }));
                expect(overflow.scrollWidth, `horizontal overflow on ${route} @${width}`).toBeLessThanOrEqual(overflow.innerWidth);

                const slug = route === "/" ? "home" : route.slice(1).replace(/\//g, "-");
                await page.screenshot({
                    path: `test-results/theme-matrix/${slug}-${mode}-${locale}-${width}.png`,
                    fullPage: true,
                });
                testInfo.annotations.push({ type: "cell", description: `${slug} ${mode} ${locale} ${width}px` });

                expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
            });
        }
    }
}
