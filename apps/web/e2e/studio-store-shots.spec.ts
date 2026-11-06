import { test, expect } from "@playwright/test";

/**
 * WP17-50 — Microsoft Store screenshots for MixAI Studio (app.mixai.ro), signed in, dark, 1920×1080.
 * Run against prod: `pnpm e2e:cloud --target https://mixai.ro --prod-session e2e/studio-store-shots.spec.ts`.
 * Each route must render without an uncaught page error; the PNGs land in test-results/studio-store/.
 */

const SESSION = process.env.E2E_SESSION_COOKIE;
const ROUTES = [
    ["1-dashboard", "/dashboard"],
    ["2-library", "/library"],
    ["3-playlists", "/playlists"],
    ["4-analysis", "/analysis"],
    ["5-mixer", "/mixer"],
] as const;

test.describe("studio store shots", () => {
    test.skip(!SESSION, "needs E2E_SESSION_COOKIE (--prod-session)");
    for (const [name, path] of ROUTES) {
        test(name, async ({ page }) => {
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(String(e)));
            await page.context().addCookies([{
                name: "__Secure-mixai.session-token", value: SESSION!, domain: ".mixai.ro", path: "/",
                httpOnly: true, secure: true, sameSite: "Lax",
            }]);
            await page.addInitScript(() => {
                localStorage.setItem("mixai:prefs:v1", JSON.stringify({ mode: "dark" }));
                localStorage.setItem("mixai:onboarding:dismissed", "1");
            });
            await page.setViewportSize({ width: 1920, height: 1080 });
            const res = await page.goto(`https://app.mixai.ro${path}`, { waitUntil: "networkidle" });
            expect(res?.status() ?? 0, `${path} status`).toBeLessThan(400);
            await page.waitForTimeout(2500);
            expect(page.url(), "not bounced to sign-in").not.toMatch(/login|signin/);
            await page.screenshot({ path: `test-results/studio-store/${name}.png` });
            expect(errors, "uncaught page errors").toEqual([]);
        });
    }
});
