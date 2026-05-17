// MMO Extension - Background Service Worker
// Cross-browser via webextension-polyfill: Chromium accepts both `chrome.*`
// and `browser.*`, but Firefox MV3 expects promise-based `browser.*` only.
// importScripts is the legal way to load scripts inside an MV3 SW.
self.importScripts("vendor/browser-polyfill.min.js");

const DEFAULT_BASE_URL = "https://muzicai.ro";

// Get base URL from storage
async function getBaseUrl() {
    try {
        const data = await browser.storage.sync.get(["baseUrl"]);
        return data.baseUrl || DEFAULT_BASE_URL;
    } catch {
        return DEFAULT_BASE_URL;
    }
}

// Handle messages from content script. With the polyfill, returning a
// Promise from the listener is the canonical async pattern (no need to
// `return true` + sendResponse).
browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === "open-download") {
        const baseUrl = await getBaseUrl();
        const downloadUrl = `${baseUrl}/download?url=${encodeURIComponent(message.url)}`;
        const finalUrl = message.autoDownload ? `${downloadUrl}&auto=1` : downloadUrl;
        await browser.tabs.create({ url: finalUrl });
        return { success: true };
    }

    if (message.type === "get-settings") {
        const data = await browser.storage.sync.get(["baseUrl", "autoDownload", "audioOnly"]);
        return {
            baseUrl: data.baseUrl || DEFAULT_BASE_URL,
            autoDownload: data.autoDownload || false,
            audioOnly: data.audioOnly !== false, // default true
        };
    }

    return undefined;
});

// Handle extension icon click when no popup
browser.action.onClicked.addListener(async (tab) => {
    if (tab.url) {
        const baseUrl = await getBaseUrl();
        const downloadUrl = `${baseUrl}/download?url=${encodeURIComponent(tab.url)}`;
        await browser.tabs.create({ url: downloadUrl });
    }
});
