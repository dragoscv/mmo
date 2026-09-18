import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the MMO web app smoke suite.
 *
 * Goal of these tests: catch the "page won't even load" class of bugs.
 * No deep interaction — just GET the route and assert it renders without
 * a 500 or an unhandled client error. Authentication-gated routes that
 * redirect to /api/auth/signin are checked by following the redirect
 * and asserting the sign-in screen renders.
 *
 * Local run:  pnpm e2e          (auto-starts the dev server)
 * CI run:    PLAYWRIGHT_BASE_URL=https://staging.mixai.ro pnpm e2e
 */

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
    testDir: "./e2e",
    timeout: 30_000,
    expect: { timeout: 5_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 2 : undefined,
    reporter: process.env.CI ? [["github"], ["list"]] : "list",
    use: {
        baseURL: BASE_URL,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "off",
    },
    projects: [
        { name: "chromium", testIgnore: /(theme-matrix|a11y)\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
        // Fixed-width projects for the responsive matrices (WP8-02). The theme
        // matrix runs at all four widths; axe runs at phone + desktop only.
        ...([390, 768, 1440, 3440] as const).map((width) => ({
            name: `w${width}`,
            testMatch: width === 390 || width === 1440 ? /(theme-matrix|a11y)\.spec\.ts$/ : /theme-matrix\.spec\.ts$/,
            use: {
                ...devices["Desktop Chrome"],
                viewport: { width, height: Math.max(720, Math.round(width * 0.62)) },
            },
        })),
    ],
    // Only spin up the dev server when we're hitting localhost; in CI
    // against a deployed env the server is already running.
    webServer: BASE_URL.startsWith("http://localhost")
        ? {
            command: "pnpm dev",
            url: BASE_URL,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
        }
        : undefined,
});
