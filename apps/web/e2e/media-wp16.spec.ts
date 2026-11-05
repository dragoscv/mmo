import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WP16-43 — cinematic `/media` surface end to end.
 *
 * Needs `E2E_SESSION_COOKIE` (Auth.js session token) and a paired MMO Server reachable from the
 * browser running the test. Every route renders at 390 / 1440 / 3440 in light and dark without
 * horizontal overflow, with no uncaught page errors, and axe finds no serious/critical violation
 * in `main`. Home timing comes from `window.__mixaiPerf.home` (cache hit must paint < 1 s).
 * The guest page `/together` must reject a malformed link without a session.
 */

const PREFS_KEY = "mixai:prefs:v1";
const MODES = ["light", "dark"] as const;
const WIDTHS = [390, 1440, 3440] as const;
const SESSION = process.env.E2E_SESSION_COOKIE;
const ROUTES = [
    "/media", "/media/search?q=a", "/media/browse/movie", "/media/browse/tv", "/media/list", "/media/stats",
    "/media/collections", "/media/music", "/media/live", "/media/live/guide", "/media/live/recordings",
    "/media/live/sources", "/media/downloads",
] as const;

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

/** Past the "Who's watching" gate: pick the first profile when the gate is shown (PIN-less profiles only). */
async function passGate(page: Page) {
    const tile = page.locator(".mx-gate-tile").first();
    if (await tile.isVisible({ timeout: 4000 }).catch(() => false)) await tile.click();
}

async function noBlockingAxe(page: Page, label: string) {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).include("main").analyze();
    const blocking = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(blocking, `${label}: ${blocking.map((v) => `${v.id}×${v.nodes.length}`).join(", ")}`).toEqual([]);
}

test("guest /together rejects a malformed link without a session", async ({ page }) => {
    const res = await page.goto("/together?server=javascript:alert(1)&inv=x");
    expect(res?.status()).toBeLessThan(400);
    await expect(page.getByRole("alert").first()).toBeVisible();
});

test.describe("signed-in /media", () => {
    test.skip(!SESSION, "set E2E_SESSION_COOKIE to an Auth.js session token to run the signed-in matrix");

    test("/ redirects to /media; Home paints from cache in < 1 s on the second visit", async ({ page, baseURL }) => {
        await signIn(page, baseURL!);
        await page.goto("/");
        await expect(page).toHaveURL(/\/media$/);
        await passGate(page);
        await expect(page.getByTestId("media-home-rows")).toBeVisible({ timeout: 20_000 });
        await page.reload();
        await expect(page.getByTestId("media-home-rows")).toBeVisible();
        const perf = await page.evaluate(() => (window as unknown as { __mixaiPerf?: { home?: { firstPaintMs: number; cached: boolean } } }).__mixaiPerf?.home);
        expect(perf?.cached, "second visit must hit the cache").toBe(true);
        expect(perf!.firstPaintMs).toBeLessThan(1000);
    });

    for (const mode of MODES) {
        for (const width of WIDTHS) {
            test(`routes render · ${mode} · ${width}px`, async ({ page, baseURL }) => {
                test.setTimeout(180_000);
                const errors: string[] = [];
                page.on("pageerror", (e) => errors.push(e.message));
                await page.setViewportSize({ width, height: Math.max(720, Math.round(width * 0.42)) });
                await signIn(page, baseURL!);
                await seedMode(page, mode);
                for (const route of ROUTES) {
                    const res = await page.goto(route);
                    expect(res?.status(), route).toBeLessThan(400);
                    await passGate(page);
                    await page.waitForLoadState("networkidle").catch(() => undefined);
                    await expect(page.locator("html")).toHaveAttribute("data-mode", mode);
                    await expect(page.locator(".mx-topbar")).toBeVisible();
                    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
                    expect(o.sw, `horizontal overflow ${route} @${width}`).toBeLessThanOrEqual(o.iw + 1);
                    const name = route.replace(/[^a-z0-9]+/gi, "_");
                    await page.screenshot({ path: `test-results/media-wp16/${name}-${mode}-${width}.png` });
                }
                expect(errors, "uncaught page errors").toEqual([]);
            });
        }
    }

    test("axe: every /media route has no serious/critical violation", async ({ page, baseURL }) => {
        test.setTimeout(180_000);
        await signIn(page, baseURL!);
        for (const route of ROUTES) {
            await page.goto(route);
            await passGate(page);
            await page.waitForLoadState("networkidle").catch(() => undefined);
            await noBlockingAxe(page, route);
        }
    });

    test("keyboard: nav toolbar arrows + '/' opens search", async ({ page, baseURL }) => {
        await signIn(page, baseURL!);
        await page.goto("/media");
        await passGate(page);
        const first = page.locator("a[data-mx-nav]").first();
        await first.focus();
        await page.keyboard.press("ArrowRight");
        await expect(page.locator("a[data-mx-nav]").nth(1)).toBeFocused();
        await page.locator("main").click({ position: { x: 5, y: 5 } }).catch(() => undefined);
        await page.keyboard.press("/");
        await expect(page).toHaveURL(/\/media\/search/);
    });
});
