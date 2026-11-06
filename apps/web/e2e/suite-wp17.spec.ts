import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * WP17-12 — mixai.ro suite landing (signed out) and launcher (signed in), plus the product hosts.
 *
 * Runs against a deployed origin with host routing on (`pnpm e2e:cloud --target https://mixai.ro --prod-session`).
 * Every surface renders at 390 / 1280 / 1920 / 3440 in light and dark with no horizontal overflow and no uncaught
 * page error; axe finds no serious/critical violation; reduced motion leaves zero running animations.
 * Screenshots land in test-results/suite-wp17/ for the design critic (docs/design-critic/wp17-suite.md).
 */

const PREFS_KEY = "mixai:prefs:v1";
const MODES = ["light", "dark"] as const;
const WIDTHS = [390, 1280, 1920, 3440] as const;
const SESSION = process.env.E2E_SESSION_COOKIE;
const ROOT = "mixai.ro";

async function seedPrefs(page: Page, prefs: Record<string, unknown>) {
    await page.addInitScript(
        ([key, p]) => {
            const prev = (() => {
                try { return JSON.parse(localStorage.getItem(key as string) ?? "{}") as Record<string, unknown>; } catch { return {}; }
            })();
            localStorage.setItem(key as string, JSON.stringify({ ...prev, ...(p as Record<string, unknown>) }));
        },
        [PREFS_KEY, prefs] as const,
    );
}

/** The product cookie is scoped to `.mixai.ro`, so one cookie signs in every product host. */
async function signIn(page: Page) {
    await page.context().addCookies([{
        name: "__Secure-mixai.session-token",
        value: SESSION!,
        domain: `.${ROOT}`,
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
    }]);
}

async function noOverflow(page: Page) {
    const o = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(o, "horizontal overflow (px)").toBeLessThanOrEqual(1);
}

test.describe("suite landing (signed out)", () => {
    for (const mode of MODES) {
        for (const width of WIDTHS) {
            test(`mixai.ro ${mode} ${width}`, async ({ page }) => {
                const errors: string[] = [];
                page.on("pageerror", (e) => errors.push(String(e)));
                await seedPrefs(page, { mode });
                await page.setViewportSize({ width, height: width < 600 ? 844 : Math.round(width * 0.5625) });
                await page.goto(`https://${ROOT}/`, { waitUntil: "networkidle" });
                await expect(page.locator("#sx-title")).toBeVisible();
                await page.waitForTimeout(1200); // entrance choreography (~900 ms)
                await noOverflow(page);
                if (width >= 1280) {
                    // One sentence per line: never a break inside a phrase ("Pe / orice ecran" at 1920 before 3.2.3).
                    const m = await page.locator("#sx-title").evaluate((el) => {
                        const lh = parseFloat(getComputedStyle(el).lineHeight);
                        const spans = [...el.querySelectorAll(".sx-title-line")];
                        return { lines: Math.round(el.getBoundingClientRect().height / lh), spans: spans.length,
                            broken: spans.filter((s) => s.getBoundingClientRect().height > lh * 1.5).length,
                            overflow: el.scrollWidth - el.clientWidth };
                    });
                    console.log(`__TITLE_LINES__ ${width} ${JSON.stringify(m)}`);
                    expect(m.broken, "a sentence wraps inside itself").toBe(0);
                    expect(m.lines, "one line per sentence").toBe(m.spans);
                    expect(m.overflow, "title overflows its column").toBeLessThanOrEqual(1);
                }
                await page.screenshot({ path: `test-results/suite-wp17/landing-${mode}-${width}.png` });
                await page.screenshot({ path: `test-results/suite-wp17/landing-${mode}-${width}-full.png`, fullPage: true });
                expect(errors, "page errors").toEqual([]);
            });
        }
    }

    test("a11y + reduced motion + RO copy", async ({ page }) => {
        await seedPrefs(page, { mode: "dark", motion: "reduced", locale: "ro" });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`https://${ROOT}/?lang=ro`, { waitUntil: "networkidle" });
        const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
        expect(running, "running animations with reduced motion").toBe(0);
        const axe = await new AxeBuilder({ page }).include("main").analyze();
        const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        console.log(`__AXE__ ${JSON.stringify(bad.map((v) => ({ id: v.id, n: v.nodes.length })))}`);
        expect(bad.map((v) => v.id)).toEqual([]);
        const probe = await page.evaluate(() => ({
            lang: document.documentElement.lang,
            title: document.querySelector("#sx-title")?.textContent,
            heading: getComputedStyle(document.querySelector("#sx-title") as Element).fontFamily,
            loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
        }));
        console.log(`__DESIGN__ ${JSON.stringify(probe)}`);
        await page.screenshot({ path: "test-results/suite-wp17/landing-ro-reduced.png" });
    });

    test("keyboard reaches the CTAs and product cards", async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`https://${ROOT}/`, { waitUntil: "networkidle" });
        const seen: string[] = [];
        for (let i = 0; i < 25; i++) {
            await page.keyboard.press("Tab");
            seen.push(await page.evaluate(() => (document.activeElement?.getAttribute("href") ?? document.activeElement?.textContent ?? "").trim().slice(0, 40)));
        }
        console.log(`__TAB__ ${JSON.stringify(seen)}`);
        expect(seen.some((s) => s.includes("tv.mixai.ro"))).toBeTruthy();
    });
});

test.describe("signed in", () => {
    test.skip(!SESSION, "E2E_SESSION_COOKIE not set");

    for (const mode of MODES) {
        for (const width of [390, 1920] as const) {
            test(`launcher ${mode} ${width}`, async ({ page }) => {
                await signIn(page);
                await seedPrefs(page, { mode });
                await page.setViewportSize({ width, height: width < 600 ? 844 : 1080 });
                await page.goto(`https://${ROOT}/`, { waitUntil: "networkidle" });
                await expect(page.locator("#lx-title")).toBeVisible({ timeout: 15_000 });
                await page.waitForTimeout(1500);
                await noOverflow(page);
                await page.screenshot({ path: `test-results/suite-wp17/launcher-${mode}-${width}.png` });
            });
        }
    }

    for (const [host, marker] of [["tv", "main"], ["music", "main"], ["app", "main"], ["dj", "main"]] as const) {
        test(`${host}.${ROOT} signed in`, async ({ page }) => {
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(String(e)));
            await signIn(page);
            await page.setViewportSize({ width: 1920, height: 1080 });
            const res = await page.goto(`https://${host}.${ROOT}/`, { waitUntil: "networkidle" });
            expect(res?.status()).toBeLessThan(400);
            await expect(page.locator(marker).first()).toBeVisible();
            const session = await page.evaluate(async () => (await fetch("/api/auth/session")).json());
            expect(session?.user?.id, "signed in on the product host").toBeTruthy();
            expect(session?.sessionToken, "session token must not be exposed").toBeUndefined();
            await page.waitForTimeout(1500);
            await page.screenshot({ path: `test-results/suite-wp17/host-${host}.png` });
            expect(errors, "page errors").toEqual([]);
        });
    }
});

test("legacy paths 308 to the product hosts", async ({ request }) => {
    for (const [from, to] of [["/media", "https://tv.mixai.ro/"], ["/media/music", "https://music.mixai.ro/"], ["/library", "https://app.mixai.ro/library"], ["/dj", "https://dj.mixai.ro/"]] as const) {
        const r = await request.get(`https://${ROOT}${from}`, { maxRedirects: 0 });
        expect(r.status(), from).toBe(308);
        expect(r.headers().location, from).toBe(to);
    }
});
