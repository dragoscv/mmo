import { test, expect } from "@playwright/test";

/**
 * Maestro song-creation E2E.
 *
 * Drives the full "AI-composed song" loop the user demoed by hand:
 *   1. Open /daw with a fresh project
 *   2. Open the Maestro chat dock
 *   3. Ask Maestro to generate a 60s techno track
 *   4. Wait for tool calls to land (createDawTrack, generateMusic)
 *   5. Assert the project doc grew tracks and at least one ready asset
 *
 * Auth — this suite needs a signed-in session. Drop a Playwright
 * storageState JSON at `app/e2e/.auth/user.json` and set
 * `PLAYWRIGHT_STORAGE_STATE=e2e/.auth/user.json` (or wire it via
 * playwright.config.ts → use.storageState). The smoke spec runs without
 * auth; this one requires it. See README for one-shot seeding:
 *   pnpm exec playwright codegen --save-storage=e2e/.auth/user.json http://localhost:13789
 *
 * Cost / time — generateMusic with tier=T0 runs ACE-Step locally on the
 * companion. A 15s clip is ~40s wall-time on RTX 3060 Ti, ~3 min on CPU.
 * We give a generous 6-minute upper bound so CI on a cold machine still
 * passes when the GPU is busy.
 *
 * Skipped automatically when no auth state is configured so this spec
 * doesn't break the smoke runs.
 */

const GENERATE_BUDGET_MS = 6 * 60_000;

test.describe("Maestro song generation", () => {
    test.skip(
        !process.env.PLAYWRIGHT_STORAGE_STATE && !process.env.CI_MAESTRO_AUTH,
        "Maestro E2E requires storageState. See file header.",
    );

    test("creates tracks from a single chat prompt", async ({ page }) => {
        test.setTimeout(GENERATE_BUDGET_MS + 30_000);

        await page.goto("/daw");
        await expect(page).toHaveURL(/\/daw/);

        // 1. Wait for the DAW shell — the transport bar with the play
        // button is the cheapest "DAW is interactive" signal we have.
        await expect(page.getByRole("button", { name: /^play$/i })).toBeVisible({ timeout: 30_000 });

        const trackCountBefore = await page.locator("[data-track-row]").count();

        // 2. Open the Maestro chat dock. The button label is "Maestro"
        // (translation key maestro.open) and lives in the top-right of
        // the DAW chrome.
        const maestroToggle = page.getByRole("button", { name: /maestro/i }).first();
        await maestroToggle.click();
        const chatInput = page.getByPlaceholder(/ask maestro/i).first();
        await expect(chatInput).toBeVisible({ timeout: 5_000 });

        // 3. Ask for a song. The phrasing maps to generateMusic with
        // tier=T0 (local) which auto-splits stems into 4 audio tracks.
        await chatInput.fill(
            "Create a 15 second melodic techno track at 124 BPM. " +
            "Use punchy four-on-the-floor kicks, snares on 2 and 4, " +
            "16th-note hi-hats, and a rolling bass on the root note. " +
            "Split into stems and put them on separate tracks.",
        );
        await chatInput.press("Enter");

        // 4. Wait for the asset row to appear in the chat with status=ready.
        // The tool result message contains the asset id and a "ready" badge.
        await expect(page.getByText(/ready|asset created/i).first()).toBeVisible({
            timeout: GENERATE_BUDGET_MS,
        });

        // 5. Confirm the project doc actually grew tracks. T0+stems adds
        // 4 tracks (drums/bass/other/vocals); we assert >= 1 to be safe
        // if the demucs split was skipped due to GPU-busy fallback.
        const trackCountAfter = await page.locator("[data-track-row]").count();
        expect(trackCountAfter, "expected new audio tracks to be created").toBeGreaterThan(trackCountBefore);

        // 6. Screenshot for human review. Lands under
        //    test-results/maestro-song-creation/.
        await page.screenshot({
            path: "test-results/maestro-song-creation/final.png",
            fullPage: true,
        });
    });
});
