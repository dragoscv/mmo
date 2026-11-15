import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * MixAI Live desktop console, RENDERED in the cloud — the design-critic pass for WP21-20.
 *
 * Browser tests never run on the workstation, so this runs against the desktop app's own Vite build
 * on the cloud VM (`pnpm e2e:cloud --target vm-live`, see `scripts/e2e-cloud/run.mjs`): the one
 * thing reading the source cannot give us. It checks the real layout at the target size, contrast
 * through axe, and whether the modes actually change what is on screen.
 *
 * There is no Tauri runtime in a browser, so the app deliberately opens Setup and says so (see
 * `store.init`): this closes that panel and then reads the console. The live engine data is absent —
 * the shell, the panels and the modes are what this verifies, not the numbers.
 */
const LIVE = process.env.LIVE_BASE_URL ?? "";
test.skip(!LIVE, "needs LIVE_BASE_URL (set by --target vm-live); not part of the web suite");

/** Both languages are shipped; the runner's locale decides which one the assertions see. */
const ANY = (en: string, ro: string) => new RegExp(`${en}|${ro}`, "i");

const SAFETY = ANY("Safety", "Siguranță");
const CHAIN = ANY("Chain", "Lanț");
const PITCH = ANY("Pitch", "Ton");
const SPECTRUM = ANY("Spectrum", "Spectru");

/** 1280x720 is the size the screen is designed for. */
const CONSOLE = { width: 1280, height: 720 };

/** Load the console: without the Tauri runtime the app opens Setup first, so close it. */
async function openConsole(page: Page): Promise<string[]> {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewportSize(CONSOLE);
    await page.goto(LIVE, { waitUntil: "load" });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 5_000 });
    return errors;
}

test("renders at 1280x720: safety bar, ribbon, spectrum, no overflow, no page error", async ({ page }) => {
    const errors = await openConsole(page);
    await expect(page).toHaveTitle(/MixAI/i);

    // The spine of direction A: the safety bar is on screen before anything else is read.
    await expect(page.getByRole("group", { name: SAFETY })).toBeVisible();
    // The limiter reads through a real ARIA meter, not a coloured div.
    await expect(page.getByRole("meter").first()).toBeVisible();
    // The two visuals of the performance screen, and the chain in normal mode.
    await expect(page.getByRole("region", { name: PITCH })).toBeVisible();
    await expect(page.getByRole("region", { name: SPECTRUM })).toBeVisible();
    await expect(page.getByRole("region", { name: CHAIN })).toBeVisible();

    // The screen is designed for 1280x720: nothing may spill sideways.
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "horizontal overflow at 1280x720").toBeLessThanOrEqual(1);

    await page.screenshot({ path: "test-results/live-desktop-1280x720.png" });
    expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
});

test("Stage mode removes the editing, keeps the safety bar, and Esc brings it back", async ({ page }) => {
    await openConsole(page);
    const chain = page.getByRole("region", { name: CHAIN });
    await expect(chain).toBeVisible();

    await page.keyboard.press("F11");
    await expect(chain).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByRole("group", { name: SAFETY })).toBeVisible();
    await expect(page.getByRole("region", { name: PITCH })).toBeVisible();
    await page.screenshot({ path: "test-results/live-desktop-stage-1280x720.png" });

    await page.keyboard.press("Escape");
    await expect(chain).toBeVisible({ timeout: 5_000 });
});

test("no serious or critical accessibility violation on the console", async ({ page }) => {
    await openConsole(page);
    await expect(page.getByRole("group", { name: SAFETY })).toBeVisible();

    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id} (${v.nodes.length} nodes)`), "serious/critical axe violations").toEqual([]);
});

// The cloud build sets VITE_LIVE_FIXTURE, which seeds a synthetic session — without it a browser has
// no engine and the chain, the hero visuals and the ribbon are never actually seen.
const FIXTURE = process.env.LIVE_FIXTURE !== "0";

test("with a session: the chain draws one hero visual per effect, none of them blank", async ({ page }) => {
    test.skip(!FIXTURE, "needs the fixture build (VITE_LIVE_FIXTURE=1)");
    await openConsole(page);

    // The fixture preset and its inserts are on screen: the chain is not "empty" any more.
    const chain = page.getByRole("region", { name: CHAIN });
    await expect(chain).toBeVisible();
    const visuals = chain.locator("svg[data-fx]");
    await expect.poll(() => visuals.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(9);

    // Every card's visual has geometry, and the nine effects are the nine the preset chains.
    const drawn = await visuals.evaluateAll((els) =>
        els.map((el) => ({
            fx: el.getAttribute("data-fx") ?? "",
            geometry: el.querySelectorAll("polyline, line, path").length,
        })),
    );
    for (const { fx, geometry } of drawn) {
        expect(geometry, `${fx} draws nothing`).toBeGreaterThan(0);
    }
    expect(new Set(drawn.map((d) => d.fx)).size, "distinct effects drawn").toBeGreaterThanOrEqual(9);

    // The mix the fixture set is what the strip shows, so the state really reached the UI.
    await expect(page.getByText(/\s-\s?3(\.0)? dB/).first()).toBeVisible();
    await page.screenshot({ path: "test-results/live-desktop-fixture-1280x720.png" });

    // And the panels that need live frames are drawn: the ribbon and spectrum canvases have ink.
    const ink = await page.evaluate(() => {
        const canvases = [...document.querySelectorAll("canvas")];
        return canvases.map((c) => {
            const ctx = c.getContext("2d");
            if (!ctx || c.width === 0 || c.height === 0) return 0;
            const data = ctx.getImageData(0, 0, c.width, c.height).data;
            let n = 0;
            for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
            return n;
        });
    });
    expect(ink.filter((n) => n > 100).length, "canvases with content").toBeGreaterThanOrEqual(3);
});

test("with a session: axe is still clean once the console is populated", async ({ page }) => {
    test.skip(!FIXTURE, "needs the fixture build (VITE_LIVE_FIXTURE=1)");
    await openConsole(page);
    await expect(page.getByRole("region", { name: CHAIN }).locator("svg[data-fx]").first()).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    expect(bad.map((v) => `${v.id} (${v.nodes.length} nodes)`), "serious/critical axe violations").toEqual([]);
});
