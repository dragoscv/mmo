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
