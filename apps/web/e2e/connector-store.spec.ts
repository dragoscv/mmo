import { test, expect, chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * WP17-53 — MixAI Connector STORE EDITION, loaded unpacked in Chromium.
 * The edition is staged into e2e/.connector-store/ by the caller (output of apps/extension/store/build.mjs) because the
 * cloud bundle carries only apps/web. Proves: no host permissions / content scripts, the popup renders localized, the
 * search button turns the active tab title (site suffix stripped) into <library>/library?search=…, and Open MixAI
 * opens the library host.
 */
const EXT = path.resolve(__dirname, ".connector-store");

test.describe("connector store edition", () => {
    test.skip(!existsSync(path.join(EXT, "manifest.json")), "store edition not staged in e2e/.connector-store");

    test("manifest is store-safe and the popup searches the library", async () => {
        const ctx = await chromium.launchPersistentContext("", {
            channel: "chromium",
            headless: true,
            args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
        });
        try {
            const probe = await ctx.newPage();
            await probe.goto("chrome://extensions/");
            const id = await probe.evaluate(async () => {
                // @ts-expect-error chrome.management is exposed on chrome:// pages
                const all: { id: string; name: string }[] = await chrome.management.getAll();
                return all.find((e) => e.name === "MixAI Connector")?.id;
            });
            expect(id, "extension loaded").toBeTruthy();
            await probe.close();

            // Opened as a tab, popup.html's tabs.query({active}) returns ITSELF (no title) -> search stays disabled.
            // Feed the active tab the way the toolbar popup sees it: a song page title.
            await ctx.addInitScript(() => {
                if (location.protocol !== "chrome-extension:" || !location.pathname.endsWith("/popup.html")) return;
                const c = (globalThis as unknown as { chrome: { tabs: { query: (...a: unknown[]) => unknown } } }).chrome;
                c.tabs.query = (_q: unknown, cb?: (t: unknown[]) => void) => {
                    const tabs = [{ id: 1, title: "Daft Punk - One More Time - YouTube", url: "https://example.com/song" }];
                    if (cb) { cb(tabs); return undefined; }
                    return Promise.resolve(tabs);
                };
            });
            const popup = await ctx.newPage();
            await popup.goto(`chrome-extension://${id}/manifest.json`);
            const manifest = JSON.parse((await popup.locator("body").innerText()) || "{}");
            expect(manifest.host_permissions ?? []).toEqual([]);
            expect(manifest.content_scripts ?? []).toEqual([]);
            expect(manifest.permissions).toEqual(["storage", "activeTab"]);

            await popup.goto(`chrome-extension://${id}/popup.html`);
            await expect(popup.locator("h1")).toHaveText("MixAI Connector");
            await expect(popup.locator("#btn-search span")).toHaveText(/Find in my MixAI library|Caută în biblioteca mea MixAI/);
            await expect(popup.locator("#page-title")).toHaveText("Daft Punk - One More Time");
            await expect(popup.locator("#btn-search")).toBeEnabled();
            // Store listing art: popup at its natural width, then centred on a 1280x800 canvas.
            await popup.setViewportSize({ width: 360, height: 420 });
            await popup.screenshot({ path: "test-results/connector-store/popup.png" });
            const shot = await popup.screenshot({ type: "png" });
            const canvas = await ctx.newPage();
            await canvas.setViewportSize({ width: 1280, height: 800 });
            await canvas.setContent(`<body style="margin:0;height:800px;display:grid;place-items:center;background:radial-gradient(circle at 30% 20%,#2a1f5c,#07060f 70%)"><img style="border-radius:14px;box-shadow:0 30px 80px #0009" src="data:image/png;base64,${shot.toString("base64")}"></body>`);
            await canvas.screenshot({ path: "test-results/connector-store/listing-1280x800.png" });
            await canvas.close();

            const opened = ctx.waitForEvent("page");
            await popup.locator("#btn-search").click();
            const tab = await opened;
            const url = new URL(tab.url());
            expect(url.origin).toBe("https://app.mixai.ro");
            expect(url.pathname).toBe("/library");
            expect(url.searchParams.get("search")).toBe("Daft Punk - One More Time");
        } finally {
            await ctx.close();
        }
    });
});
