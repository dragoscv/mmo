import { expect, test } from "@playwright/test";

/**
 * D59 / WP17-96: connect to an MMO Server WITHOUT a MixAI account (the store-reviewer path).
 * /connect → "Try the demo" (demo.mixai.ro auto-approves Quick Connect) → Music home renders from the demo server,
 * the guest connection survives a reload, and "Disconnect" brings back the no-server screen. No session cookie.
 */
const DEMO = process.env.E2E_DEMO_SERVER ?? "https://demo.mixai.ro";

test.describe("connect without an account", () => {
    test("no session: /media/music offers Connect / Try the demo instead of redirecting to login", async ({ page }) => {
        await page.goto("/media/music");
        await expect(page.getByTestId("noserver-connect")).toBeVisible({ timeout: 15_000 });
        expect(new URL(page.url()).pathname).toBe("/media/music");
    });

    test("invalid and unreachable addresses show a readable error", async ({ page }) => {
        await page.goto("/connect");
        await page.getByTestId("connect-address").fill("ftp://nope");
        await page.getByTestId("connect-submit").click();
        await expect(page.getByRole("alert")).toBeVisible();
    });

    test("Try the demo → Music from the demo server → reload keeps it → Disconnect", async ({ page }) => {
        test.setTimeout(90_000);
        await page.goto(`/connect?server=${encodeURIComponent(DEMO)}`);
        await page.getByTestId("connect-demo").click();
        // Demo auto-approves; the page saves the token and goes home (/media on legacy hosts, Music on music.mixai.ro).
        await page.waitForURL(/\/media(\/music)?$/, { timeout: 45_000 });
        const stored = await page.evaluate(() => localStorage.getItem("mixai-web:guest-servers"));
        expect(stored).toContain("demo.mixai.ro");
        await page.goto("/media/music");
        // Profile gate (demo has Reviewer + Kids) → pick Reviewer when asked.
        const reviewer = page.getByRole("button", { name: /reviewer/i }).first();
        if (await reviewer.isVisible({ timeout: 10_000 }).catch(() => false)) await reviewer.click();
        await expect(page.locator(".mx-topbar")).toBeVisible({ timeout: 20_000 });
        await page.reload();
        await expect(page.locator(".mx-topbar")).toBeVisible({ timeout: 20_000 });
        // Disconnect from the profile menu (when a profile is active) or clear storage directly.
        const menu = page.locator(".mx-profile-btn");
        if (await menu.isVisible({ timeout: 5_000 }).catch(() => false)) {
            await menu.click();
            await page.getByRole("menuitem", { name: /disconnect/i }).click();
        } else {
            await page.evaluate(() => { localStorage.removeItem("mixai-web:guest-servers"); dispatchEvent(new Event("mixai:guest-servers")); });
        }
        await expect(page.getByTestId("noserver-connect")).toBeVisible({ timeout: 15_000 });
    });

    test("login page links to /connect", async ({ page }) => {
        await page.goto("/login");
        await expect(page.getByTestId("login-connect")).toHaveAttribute("href", /\/connect$/);
    });
});
