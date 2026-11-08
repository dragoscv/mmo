import { test, expect, type Page } from "@playwright/test";

/**
 * WP17-43 — Microsoft Store / Mac App Store screenshots for MixAI Music (music.mixai.ro), as a GUEST of the public
 * demo server (D59: Connect → Try the demo), dark. No account and no owner data in the shots.
 * Run: `node scripts/e2e-cloud/run.mjs --target https://music.mixai.ro e2e/music-store-shots.spec.ts`.
 * Viewport via SHOTS_SIZE (default 1920x1080; Mac App Store wants 2880x1800 → use 1440x900 at scale 2).
 */

const ORIGIN = process.env.SHOTS_ORIGIN ?? "https://music.mixai.ro";
const [W, H] = (process.env.SHOTS_SIZE ?? "1920x1080").split("x").map(Number);
const SCALE = Number(process.env.SHOTS_SCALE ?? "1");
const DIR = `test-results/music-store/${W * SCALE}x${H * SCALE}`;

async function connectDemo(page: Page) {
    await page.goto(`${ORIGIN}/connect?demo=1`);
    await page.waitForFunction(() => (localStorage.getItem("mixai-web:guest-servers") ?? "").includes("demo.mixai.ro"), null, { timeout: 60_000, polling: 500 });
}

async function passProfileGate(page: Page) {
    const reviewer = page.getByRole("region").getByRole("button", { name: /^R?\s*Reviewer$/i }).first();
    if (await reviewer.waitFor({ timeout: 8_000 }).then(() => true, () => false)) {
        await reviewer.click();
        await reviewer.waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
    }
}

test.use({ colorScheme: "dark" });

test("music store shots (guest of demo)", async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, colorScheme: "dark" });
    await ctx.addInitScript(() => {
        localStorage.setItem("mixai:prefs:v1", JSON.stringify({ mode: "dark" }));
        localStorage.setItem("mixai:onboarding:dismissed", "1");
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await connectDemo(page);

    await page.goto(`${ORIGIN}/media/music`);
    await passProfileGate(page);
    await page.waitForLoadState("networkidle");
    const album = page.locator('main a[href*="/album/"]').first();
    await album.waitFor({ timeout: 30_000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${DIR}/1-home.png` });

    // First album → album page (gapless, tracklist).
    await album.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${DIR}/2-album.png` });

    // Play it → Now Playing.
    const play = page.getByRole("button", { name: /^(play|redă)/i }).first();
    if (await play.isVisible()) await play.click();
    await page.waitForTimeout(3000);
    await page.goto(`${ORIGIN}/media/music/now-playing`);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${DIR}/3-now-playing.png` });

    await page.goto(`${ORIGIN}/media/music/search?q=a`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${DIR}/4-search.png` });

    await page.goto(`${ORIGIN}/connect`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${DIR}/5-connect.png` });

    expect(errors, "uncaught page errors").toEqual([]);
    await ctx.close();
});
