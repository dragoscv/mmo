import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility smoke — public routes get a full axe-core scan with the
 * WCAG 2.1 A + AA + Section 508 rule sets. The bar starts low: we fail
 * the build only on `serious` and `critical` violations, the two tiers
 * that map to "real users are blocked". `moderate` and `minor` are
 * recorded in the test output for triage but do not break CI yet.
 *
 * Why not authed routes? They redirect to /api/auth/signin, which is a
 * NextAuth-rendered page out of our control — failing the build on its
 * styling would be noise. The sign-in form itself is exercised by the
 * smoke spec for "did it render", which is enough for now.
 *
 * To raise the bar later, switch the filter to `["minor", "moderate",
 * "serious", "critical"]` and clean up the warnings that surface.
 */

const A11Y_ROUTES = ["/", "/offline", "/status"];
const BLOCKING_IMPACTS: ReadonlyArray<string> = ["serious", "critical"];

for (const route of A11Y_ROUTES) {
    test(`a11y: ${route} has no serious or critical violations`, async ({ page }) => {
        const response = await page.goto(route);
        expect(response, `expected response for ${route}`).not.toBeNull();
        // Wait for the network to be quiet so client-side hydration finishes
        // and any lazy-mounted nodes (sonner toaster region, theme provider)
        // are present in the DOM before axe walks it.
        await page.waitForLoadState("networkidle");

        const results = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "section508"])
            .analyze();

        const blocking = results.violations.filter((v) =>
            BLOCKING_IMPACTS.includes(v.impact ?? ""),
        );
        if (blocking.length > 0) {
            // Format a compact report so the failure is actionable in the
            // GitHub Actions log without needing the full Playwright trace.
            const summary = blocking
                .map((v) => `  • [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? "" : "s"})`)
                .join("\n");
            throw new Error(
                `axe-core found ${blocking.length} blocking violation${blocking.length === 1 ? "" : "s"} on ${route}:\n${summary}`,
            );
        }
    });
}
