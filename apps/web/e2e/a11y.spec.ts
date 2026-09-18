import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility gate — axe-core (WCAG 2.1 A/AA + Section 508) over the shell
 * routes in light AND dark, at the widths supplied by the Playwright projects
 * (`w390` + `w1440`, see playwright.config.ts).
 *
 * We fail only on `serious` and `critical` — the two tiers that map to "a real
 * user is blocked". `moderate`/`minor` are printed for triage but do not break
 * the build yet. To raise the bar, extend BLOCKING_IMPACTS.
 *
 * Auth-gated routes render their own NotSignedIn empty state inside the shell
 * (they do NOT redirect to the NextAuth page any more), so the shell chrome —
 * sidebar, bottom tab bar, theme controls — is what gets scanned.
 *
 * ALLOWED_RULES is the escape hatch for a known, documented violation. It is
 * intentionally empty: adding an id here needs a comment with the issue link.
 */

// `/media/movie/550` (WP11-09) renders the NotSignedIn shell anonymously and the
// full title page when a session cookie is present — both get scanned.
const ROUTES = ["/", "/library", "/settings/appearance", "/get", "/media/movie/550"] as const;
const MODES = ["light", "dark"] as const;
const BLOCKING_IMPACTS: ReadonlyArray<string> = ["serious", "critical"];
/** axe rule ids exempted from the gate. Keep empty; document any addition. */
const ALLOWED_RULES: ReadonlyArray<string> = [];
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
    for (const route of ROUTES) {
        test(`a11y: ${route} (${mode}) has no serious/critical violations`, async ({ page }) => {
            const width = page.viewportSize()?.width ?? 0;
            expect(width, "spec must run under a w<width> project").toBeGreaterThan(0);

            await setMode(page, mode);
            const response = await page.goto(route);
            expect(response, `expected response for ${route}`).not.toBeNull();
            expect(response!.status(), `${route} status`).toBeLessThan(400);
            // Let hydration + lazy-mounted regions (toaster, theme provider,
            // measured tab bar) settle before axe walks the tree.
            await page.waitForLoadState("networkidle");
            await expect(page.locator("html")).toHaveAttribute("data-mode", mode);

            const results = await new AxeBuilder({ page })
                .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "section508"])
                .disableRules([...ALLOWED_RULES])
                .analyze();

            const nonBlocking = results.violations.filter((v) => !BLOCKING_IMPACTS.includes(v.impact ?? ""));
            if (nonBlocking.length > 0) {
                // Visible in the reporter without failing the run.
                console.log(`[a11y triage] ${route} ${mode} @${width}: ${nonBlocking.map((v) => `${v.impact}:${v.id}×${v.nodes.length}`).join(", ")}`);
            }

            const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.includes(v.impact ?? ""));
            const summary = blocking
                .map((v) => `  • [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})\n` + v.nodes.slice(0, 3).map((n) => `      ${n.target.join(" ")}`).join("\n"))
                .join("\n");
            expect(blocking, `axe-core blocking violations on ${route} (${mode}, ${width}px):\n${summary}`).toEqual([]);
        });
    }
}
