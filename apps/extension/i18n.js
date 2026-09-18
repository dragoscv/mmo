// MixAI Extension - shared i18n helper for popup/options pages.
// Requires vendor/browser-polyfill.min.js to be loaded first.

/** Translate a key; falls back to the element's existing text when missing. */
function t(key, substitutions) {
    try {
        const msg = browser.i18n.getMessage(key, substitutions);
        if (msg) return msg;
    } catch { /* i18n unavailable (e.g. file:// preview) */ }
    return "";
}

/** Replace textContent of every [data-i18n] element with its message. */
function applyI18n(root = document) {
    for (const el of root.querySelectorAll("[data-i18n]")) {
        const msg = t(el.getAttribute("data-i18n"));
        if (msg) el.textContent = msg;
    }
    for (const el of root.querySelectorAll("[data-i18n-title]")) {
        const msg = t(el.getAttribute("data-i18n-title"));
        if (msg) el.title = msg;
    }
    try {
        const lang = browser.i18n.getUILanguage();
        if (lang) document.documentElement.lang = lang.slice(0, 2);
    } catch { /* ignore */ }
}
