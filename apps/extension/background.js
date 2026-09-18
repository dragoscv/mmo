// MixAI Extension - Background Service Worker
// Cross-browser via webextension-polyfill: Chromium accepts both `chrome.*`
// and `browser.*`, but Firefox MV3 expects promise-based `browser.*` only.
// importScripts is the legal way to load scripts inside an MV3 SW.
self.importScripts("vendor/browser-polyfill.min.js");

const DEFAULT_BASE_URL = "https://mixai.ro";

// Read settings from storage (defaults when SW cold-starts without sync)
async function getSettings() {
    try {
        const data = await browser.storage.sync.get(["baseUrl", "autoDownload", "audioOnly"]);
        return {
            baseUrl: data.baseUrl || DEFAULT_BASE_URL,
            autoDownload: data.autoDownload || false,
            audioOnly: data.audioOnly !== false, // default true
        };
    } catch {
        return { baseUrl: DEFAULT_BASE_URL, autoDownload: false, audioOnly: true };
    }
}

// /download in apps/web reads `url` and `auto=1`; `audio=1` carries the
// stored "audio only" preference for the web app to honour.
function buildDownloadUrl(baseUrl, mediaUrl, { auto, audioOnly }) {
    const params = new URLSearchParams({ url: mediaUrl });
    if (auto) params.set("auto", "1");
    if (audioOnly) params.set("audio", "1");
    return `${baseUrl}/download?${params.toString()}`;
}

// Handle messages from content script. With the polyfill, returning a
// Promise from the listener is the canonical async pattern (no need to
// `return true` + sendResponse).
browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === "open-download") {
        const s = await getSettings();
        const finalUrl = buildDownloadUrl(s.baseUrl, message.url, {
            auto: message.autoDownload ?? s.autoDownload,
            audioOnly: message.audioOnly ?? s.audioOnly,
        });
        await browser.tabs.create({ url: finalUrl });
        return { success: true };
    }

    if (message.type === "get-settings") {
        return getSettings();
    }

    return undefined;
});

// Handle extension icon click when no popup
browser.action.onClicked.addListener(async (tab) => {
    if (tab.url) {
        const s = await getSettings();
        await browser.tabs.create({ url: buildDownloadUrl(s.baseUrl, tab.url, { auto: false, audioOnly: s.audioOnly }) });
    }
});
