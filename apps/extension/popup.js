// MixAI Extension - Popup Script

document.addEventListener("DOMContentLoaded", () => {
    applyI18n();

    const btnDownload = document.getElementById("btn-download");
    const btnDownloadLabel = document.getElementById("btn-download-label");
    const btnOpen = document.getElementById("btn-open");
    const pageTitle = document.getElementById("page-title");
    const pagePlatform = document.getElementById("page-platform");
    const baseUrlLink = document.getElementById("base-url-link");
    const settingsLink = document.getElementById("settings-link");
    const versionEl = document.getElementById("version");

    let currentUrl = "";
    let settings = { baseUrl: "https://mixai.ro", autoDownload: false, audioOnly: true };

    // Version comes from the manifest so it can never drift from the release.
    try {
        versionEl.textContent = `v${browser.runtime.getManifest().version}`;
    } catch { /* ignore */ }

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
    browser.storage.sync.get(["baseUrl", "autoDownload", "audioOnly"]).then((data) => {
        settings.baseUrl = data.baseUrl || "https://mixai.ro";
        settings.autoDownload = data.autoDownload || false;
        settings.audioOnly = data.audioOnly !== false; // default true
        baseUrlLink.textContent = settings.baseUrl.replace(/^https?:\/\//, "");
        baseUrlLink.href = settings.baseUrl;
        const label = t(settings.audioOnly ? "downloadAudio" : "downloadMedia");
        if (label) btnDownloadLabel.textContent = label;
    });

    // Get current tab
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        if (tabs[0]) {
            currentUrl = tabs[0].url || "";
            pageTitle.textContent = tabs[0].title || t("unknownPage") || "Unknown page";

            const platform = detectPlatform(currentUrl);
            if (platform) {
                pagePlatform.textContent = t("platformDetected", [platform]) || `✓ ${platform} detected`;
                pagePlatform.classList.add("detected");
            } else {
                pagePlatform.textContent = t("notPlatform") || "Not a known streaming platform";
                pagePlatform.classList.remove("detected");
            }
        }
    });

    function buildDownloadUrl(auto) {
        const params = new URLSearchParams({ url: currentUrl });
        if (auto) params.set("auto", "1");
        if (settings.audioOnly) params.set("audio", "1");
        return `${settings.baseUrl}/download?${params.toString()}`;
    }

    // Download button
    btnDownload.addEventListener("click", () => {
        if (!currentUrl) return;
        browser.tabs.create({ url: buildDownloadUrl(true) });
        window.close();
    });

    // Open in MixAI button
    btnOpen.addEventListener("click", () => {
        if (!currentUrl) return;
        browser.tabs.create({ url: buildDownloadUrl(false) });
        window.close();
    });

    // Settings
    settingsLink.addEventListener("click", (e) => {
        e.preventDefault();
        browser.runtime.openOptionsPage();
    });
});
