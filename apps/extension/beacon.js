// MMO Extension — presence beacon for muzicai.ro
// Injects a <meta name="mmo-extension" content="<version>"> tag so the
// Download Hub in the web app can detect that the extension is installed.
// Kept intentionally tiny: no listeners, no DOM observation, just a marker.

(function () {
    "use strict";
    if (document.querySelector('meta[name="mmo-extension"]')) return;
    try {
        const meta = document.createElement("meta");
        meta.name = "mmo-extension";
        const version =
            (typeof browser !== "undefined" && browser.runtime?.getManifest?.().version) ||
            (typeof chrome !== "undefined" && chrome.runtime?.getManifest?.().version) ||
            "unknown";
        meta.content = String(version);
        (document.head || document.documentElement).appendChild(meta);
    } catch {
        // Manifest unavailable (extension reloaded) — silently skip; the
        // hub will just say "not detected" until the next page load.
    }
})();
