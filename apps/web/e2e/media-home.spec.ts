import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WP11-09 — Media Home end to end.
 *
 * Anonymous `/` must render the landing (sign-in CTA, no hero billboard).
 * When `E2E_SESSION_COOKIE` holds an Auth.js session token, the signed-in
 * `/` renders the hero + at least one row at 390 / 1440 / 3440 in light and
 * dark (same prefs seeding as theme-matrix.spec.ts), with no horizontal
 * overflow, and axe finds no serious/critical violation on `/` and on
 * `/media/movie/550`. Runs under the default `chromium` project; widths are
 * set per test so the spec does not depend on the w* projects.
 */

const PREFS_KEY = "mixai:prefs:v1";
const MODES = ["light", "dark"] as const;
const WIDTHS = [390, 1440, 3440] as const;
const SESSION = process.env.E2E_SESSION_COOKIE;

async function seedMode(page: Page, mode: (typeof MODES)[number]) {
    await page.addInitScript(
        ([key, m]) => {
            const prev = (() => {
                try { return JSON.parse(localStorage.getItem(key as string) ?? "{}") as Record<string, unknown>; } catch { return {}; }
            })();
            localStorage.setItem(key as string, JSON.stringify({ ...prev, mode: m }));
        },
        [PREFS_KEY, mode] as const,
    );
}

async function signIn(page: Page, baseURL: string) {
    const secure = baseURL.startsWith("https://");
    await page.context().addCookies([{
        name: secure ? "__Secure-authjs.session-token" : "authjs.session-token",
        value: SESSION!,
        url: baseURL,
        httpOnly: true,
        secure,
    }]);
}

/**
 * Axe over the page content (`main`). The app shell is gated by a11y.spec.ts.
 * `color-contrast` is excluded HERE ONLY because a11y.spec.ts already reports it
 * on `/` (landing hero button + feature cards mid-fade-in, token contrast —
 * tracked there, not duplicated); structure/ARIA rules stay blocking.
 */
async function noBlockingAxe(page: Page, label: string) {
    const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .include("main")
        .disableRules(["color-contrast"])
        .analyze();
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking, `${label}: ${blocking.map((v) => `${v.id}×${v.nodes.length}`).join(", ")}`).toEqual([]);
}

test("anonymous / renders the landing, not Media Home", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBeLessThan(400);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("[data-slot=hero-billboard]")).toHaveCount(0);
    await expect(page.locator("[data-slot=media-row]")).toHaveCount(0);
    // Landing CTA: sign-in button + /get link.
    await expect(page.locator('a[href="/get"]').first()).toBeVisible();
    await noBlockingAxe(page, "anonymous /");
});

test.describe("signed-in Media Home", () => {
    test.skip(!SESSION, "set E2E_SESSION_COOKIE to an Auth.js session token to run the signed-in matrix");

    for (const mode of MODES) {
        for (const width of WIDTHS) {
            test(`/ hero + rows · ${mode} · ${width}px`, async ({ page, baseURL }) => {
                await page.setViewportSize({ width, height: Math.max(720, Math.round(width * 0.62)) });
                await signIn(page, baseURL!);
                await seedMode(page, mode);
                const res = await page.goto("/");
                expect(res?.status()).toBeLessThan(400);
                await page.waitForLoadState("networkidle");
                await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

                await expect(page.locator("[data-slot=hero-billboard]")).toBeVisible();
                await expect(page.locator("[data-slot=media-row] [role=list]").first()).toBeVisible();
                expect(await page.locator("[data-slot=media-row]").count()).toBeGreaterThanOrEqual(1);

                const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
                expect(overflow.sw, `horizontal overflow @${width}`).toBeLessThanOrEqual(overflow.iw);
                await page.screenshot({ path: `test-results/media-home/home-${mode}-${width}.png`, fullPage: true });
            });
        }
    }

    test("axe: / and /media/movie/550 have no serious/critical violations", async ({ page, baseURL }) => {
        await signIn(page, baseURL!);
        for (const route of ["/", "/media/movie/550"]) {
            const res = await page.goto(route);
            expect(res?.status(), route).toBeLessThan(400);
            await page.waitForLoadState("networkidle");
            await noBlockingAxe(page, route);
        }
    });
});
