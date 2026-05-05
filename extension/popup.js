// MMO Extension - Popup Script

document.addEventListener("DOMContentLoaded", () => {
    const btnDownload = document.getElementById("btn-download");
    const btnOpen = document.getElementById("btn-open");
    const pageTitle = document.getElementById("page-title");
    const pagePlatform = document.getElementById("page-platform");
    const baseUrlLink = document.getElementById("base-url-link");
    const settingsLink = document.getElementById("settings-link");

    let currentUrl = "";
    let settings = { baseUrl: "https://muzicai.ro", autoDownload: false };

    // Supported platforms
    const PLATFORMS = {
        "youtube.com": "YouTube",
        "music.youtube.com": "YouTube Music",
        "soundcloud.com": "SoundCloud",
        "open.spotify.com": "Spotify",
        "bandcamp.com": "Bandcamp",
        "mixcloud.com": "Mixcloud",
        "vimeo.com": "Vimeo",
        "tiktok.com": "TikTok",
        "twitter.com": "Twitter/X",
        "x.com": "Twitter/X",
        "instagram.com": "Instagram",
        "facebook.com": "Facebook",
        "twitch.tv": "Twitch",
        "dailymotion.com": "Dailymotion",
        "deezer.com": "Deezer",
    };

    function detectPlatform(url) {
        try {
            const hostname = new URL(url).hostname;
            for (const [domain, name] of Object.entries(PLATFORMS)) {
                if (hostname.includes(domain)) return name;
            }
        } catch { /* ignore */ }
        return null;
    }

    // Load settings
    chrome.storage.sync.get(["baseUrl", "autoDownload"], (data) => {
        settings.baseUrl = data.baseUrl || "https://muzicai.ro";
        settings.autoDownload = data.autoDownload || false;
        baseUrlLink.textContent = settings.baseUrl.replace(/^https?:\/\//, "");
        baseUrlLink.href = settings.baseUrl;
    });

    // Get current tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            currentUrl = tabs[0].url || "";
            pageTitle.textContent = tabs[0].title || "Unknown page";

            const platform = detectPlatform(currentUrl);
            if (platform) {
                pagePlatform.textContent = `✓ ${platform} detected`;
                pagePlatform.style.color = "#22c55e";
            } else {
                pagePlatform.textContent = "Not a known streaming platform";
                pagePlatform.style.color = "rgba(255,255,255,0.25)";
            }
        }
    });

    // Download button
    btnDownload.addEventListener("click", () => {
        if (!currentUrl) return;
        const downloadUrl = `${settings.baseUrl}/download?url=${encodeURIComponent(currentUrl)}&auto=1`;
        chrome.tabs.create({ url: downloadUrl });
        window.close();
    });

    // Open in MMO button
    btnOpen.addEventListener("click", () => {
        if (!currentUrl) return;
        const downloadUrl = `${settings.baseUrl}/download?url=${encodeURIComponent(currentUrl)}`;
        chrome.tabs.create({ url: downloadUrl });
        window.close();
    });

    // Settings
    settingsLink.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.runtime.openOptionsPage();
    });
});
