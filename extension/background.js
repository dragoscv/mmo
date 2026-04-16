// MMO Extension - Background Service Worker

const DEFAULT_BASE_URL = "http://localhost:3000";

// Get base URL from storage
async function getBaseUrl() {
    try {
        const data = await chrome.storage.sync.get(["baseUrl"]);
        return data.baseUrl || DEFAULT_BASE_URL;
    } catch {
        return DEFAULT_BASE_URL;
    }
}

// Handle messages from content script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "open-download") {
        getBaseUrl().then(baseUrl => {
            const downloadUrl = `${baseUrl}/download?url=${encodeURIComponent(message.url)}`;
            if (message.autoDownload) {
                chrome.tabs.create({ url: downloadUrl + "&auto=1" });
            } else {
                chrome.tabs.create({ url: downloadUrl });
            }
            sendResponse({ success: true });
        });
        return true; // Keep message channel open for async response
    }

    if (message.type === "get-settings") {
        chrome.storage.sync.get(["baseUrl", "autoDownload", "audioOnly"], (data) => {
            sendResponse({
                baseUrl: data.baseUrl || DEFAULT_BASE_URL,
                autoDownload: data.autoDownload || false,
                audioOnly: data.audioOnly !== false, // default true
            });
        });
        return true;
    }
});

// Handle extension icon click when no popup
chrome.action.onClicked.addListener(async (tab) => {
    if (tab.url) {
        const baseUrl = await getBaseUrl();
        const downloadUrl = `${baseUrl}/download?url=${encodeURIComponent(tab.url)}`;
        chrome.tabs.create({ url: downloadUrl });
    }
});
