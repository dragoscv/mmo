import { test, expect, type Page } from "@playwright/test";

/**
 * WP9-01 — cheap visual regression for the `@mmo/ui` catalog at /dev/ui.
 * Loads the page at four widths × light/dark and writes full-page screenshots
 * to test-results/ui-catalog/. Only asserts "200 + no console errors"; the
 * PNGs are for eyeballing / an external diff tool.
 *
 * Skipped automatically when the route 404s (production without MIXAI_DEV_UI=1).
 */

const WIDTHS = [390, 768, 1440, 3440] as const;
const MODES = ["light", "dark"] as const;
const PREFS_KEY = "mixai:prefs:v1";

async function setMode(page: Page, mode: (typeof MODES)[number]) {
    await page.addInitScript(
        ([key, m]) => {
            const prev = (() => {
                try {
                    return JSON.parse(localStorage.getItem(key as string) ?? "{}") as Record<string, unknown>;
                } catch {
                    return {};
                }
            })();
            localStorage.setItem(key as string, JSON.stringify({ ...prev, mode: m }));
        },
        [PREFS_KEY, mode] as const,
    );
}

for (const mode of MODES) {
    for (const width of WIDTHS) {
        test(`/dev/ui renders at ${width}px in ${mode}`, async ({ page }) => {
            const consoleErrors: string[] = [];
            page.on("console", (msg) => {
                if (msg.type() === "error") consoleErrors.push(msg.text());
            });
            page.on("pageerror", (err) => consoleErrors.push(err.message));

            await setMode(page, mode);
            await page.setViewportSize({ width, height: Math.round(width * 0.62) });

            const response = await page.goto("/dev/ui");
            expect(response).not.toBeNull();
            test.skip(response!.status() === 404, "/dev/ui is disabled in this environment");
            expect(response!.status()).toBe(200);

            await page.waitForLoadState("networkidle");
            await expect(page.locator("[data-ui-catalog]")).toBeVisible();

            await page.screenshot({ path: `test-results/ui-catalog/${mode}-${width}.png`, fullPage: true });

            // Matrix on — forces light/dark × glass/solid/flat side by side.
            await page.getByRole("switch").first().click();
            await expect(page.locator("[data-catalog-section='matrix']")).toBeVisible();
            await page.screenshot({ path: `test-results/ui-catalog/${mode}-${width}-matrix.png`, fullPage: true });

            expect(consoleErrors, consoleErrors.join("\n")).toEqual([]);
        });
    }
}
