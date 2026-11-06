// MixAI Connector (store edition) — popup.
// No downloads and no access to third-party sites: the popup reads only the active tab's title (activeTab, granted
// by the click) and opens the user's own MixAI library with that text as a search, or MixAI itself.

document.addEventListener("DOMContentLoaded", () => {
    applyI18n();

    const pageTitle = document.getElementById("page-title");
    const btnSearch = document.getElementById("btn-search");
    const btnOpen = document.getElementById("btn-open");
    const baseUrlLink = document.getElementById("base-url-link");
    const settingsLink = document.getElementById("settings-link");
    const versionEl = document.getElementById("version");

    let query = "";
    let baseUrl = "https://app.mixai.ro";

    try {
        versionEl.textContent = `v${browser.runtime.getManifest().version}`;
    } catch { /* ignore */ }

    // Strip the site suffix most players append ("Song - Artist - YouTube", "Artist · Song | Spotify").
    function cleanTitle(title) {
        return String(title || "")
            .replace(/\s*[-|·•–—]\s*(YouTube Music|YouTube|Spotify|SoundCloud|Deezer|Bandcamp|Mixcloud|Apple Music)\s*$/i, "")
            .replace(/^\(\d+\)\s*/, "")
            .trim()
            .slice(0, 120);
    }

    browser.storage.sync.get(["libraryUrl"]).then((data) => {
        baseUrl = (data.libraryUrl || "https://app.mixai.ro").replace(/\/+$/, "");
        baseUrlLink.textContent = baseUrl.replace(/^https?:\/\//, "");
        baseUrlLink.href = baseUrl;
    });

    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        query = cleanTitle(tabs[0]?.title);
        pageTitle.textContent = query || t("unknownPage") || "Unknown page";
        btnSearch.disabled = !query;
    });

    btnSearch.addEventListener("click", () => {
        if (!query) return;
        browser.tabs.create({ url: `${baseUrl}/library?search=${encodeURIComponent(query)}` });
        window.close();
    });

    btnOpen.addEventListener("click", () => {
        browser.tabs.create({ url: baseUrl });
        window.close();
    });

    settingsLink.addEventListener("click", (e) => {
        e.preventDefault();
        browser.runtime.openOptionsPage();
    });
});
