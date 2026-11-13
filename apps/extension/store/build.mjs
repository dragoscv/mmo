// MixAI Connector — STORE EDITION builder (WP17-53, owner decision 2026-11-06).
// The GitHub build adds a download button on streaming sites; store policies forbid that, and a strike would hit the
// shared Microsoft/Google developer account. This edition has NO host permissions and NO content scripts: the popup
// searches the user's own MixAI library for the active tab's title (activeTab) or opens MixAI.
//
//   node apps/extension/store/build.mjs [--zip]   -> apps/extension/build/store/ (+ mixai-connector-store-vX.zip)
import { mkdirSync, rmSync, readFileSync, writeFileSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const out = path.join(ext, "build", "store");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const base = JSON.parse(readFileSync(path.join(ext, "manifest.json"), "utf8"));
const manifest = {
    manifest_version: 3,
    name: "__MSG_extName__",
    version: base.version,
    description: "__MSG_extDescription__",
    default_locale: "en",
    browser_specific_settings: { gecko: { id: "mixai-connector@mixai.ro", strict_min_version: "115.0" } },
    permissions: ["storage", "activeTab"],
    options_ui: { page: "options.html", open_in_tab: false },
    action: { default_popup: "popup.html", default_icon: base.icons },
    icons: base.icons,
};
writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 4) + "\n");

const MESSAGES = {
    en: {
        extName: "MixAI Connector",
        extDescription: "Find the song you are looking at in your own MixAI library, in one click.",
        popupTitle: "MixAI Connector",
        currentPage: "On this page",
        loading: "Loading…",
        unknownPage: "Nothing to search on this page",
        searchLibrary: "Find in my MixAI library",
        openInMixai: "Open MixAI",
        connectedTo: "Library",
        settings: "⚙ Settings",
        optionsTitle: "MixAI Connector – Settings",
        optionsHeading: "MixAI Connector settings",
        libraryUrlLabel: "MixAI library address",
        libraryUrlHint: "Where your MixAI library opens (default: https://app.mixai.ro).",
        save: "Save settings",
        saved: "✓ Saved",
    },
    ro: {
        extName: "MixAI Connector",
        extDescription: "Găsește piesa pe care o vezi în propria bibliotecă MixAI, dintr-un clic.",
        popupTitle: "MixAI Connector",
        currentPage: "Pe această pagină",
        loading: "Se încarcă…",
        unknownPage: "Nimic de căutat pe această pagină",
        searchLibrary: "Caută în biblioteca mea MixAI",
        openInMixai: "Deschide MixAI",
        connectedTo: "Bibliotecă",
        settings: "⚙ Setări",
        optionsTitle: "MixAI Connector – Setări",
        optionsHeading: "Setări MixAI Connector",
        libraryUrlLabel: "Adresa bibliotecii MixAI",
        libraryUrlHint: "Unde se deschide biblioteca ta MixAI (implicit: https://app.mixai.ro).",
        save: "Salvează setările",
        saved: "✓ Salvat",
    },
};
const keysEn = Object.keys(MESSAGES.en).sort().join();
if (Object.keys(MESSAGES.ro).sort().join() !== keysEn) throw new Error("store messages: RO/EN key parity broken");
for (const [lang, msgs] of Object.entries(MESSAGES)) {
    mkdirSync(path.join(out, "_locales", lang), { recursive: true });
    const json = Object.fromEntries(Object.entries(msgs).map(([k, v]) => [k, { message: v }]));
    writeFileSync(path.join(out, "_locales", lang, "messages.json"), JSON.stringify(json, null, 4) + "\n");
}

// Pages: keep the shared <head>/styles of the GitHub build, replace the body.
function page(file, body) {
    const src = readFileSync(path.join(ext, file), "utf8");
    const head = src.slice(0, src.indexOf("<body>"));
    writeFileSync(path.join(out, file), `${head}<body>\n${body}\n</body>\n\n</html>\n`);
}
page("popup.html", `    <div class="header">
        <img class="logo" src="icons/icon48.png" width="28" height="28" alt="">
        <h1 data-i18n="popupTitle">MixAI Connector</h1>
        <span class="version" id="version"></span>
    </div>

    <div class="current-page">
        <div class="label" data-i18n="currentPage">On this page</div>
        <div class="title" id="page-title" data-i18n="loading">Loading…</div>
    </div>

    <button class="btn btn-primary" id="btn-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span data-i18n="searchLibrary">Find in my MixAI library</span>
    </button>

    <button class="btn btn-secondary" id="btn-open">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
            stroke-linejoin="round" aria-hidden="true">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        <span data-i18n="openInMixai">Open MixAI</span>
    </button>

    <div class="status">
        <span data-i18n="connectedTo">Library</span> <a href="#" id="base-url-link">app.mixai.ro</a>
    </div>
    <a class="settings-link" id="settings-link" href="#" data-i18n="settings">⚙ Settings</a>

    <script src="vendor/browser-polyfill.min.js"></script>
    <script src="i18n.js"></script>
    <script src="popup.js"></script>`);
page("options.html", `    <h1><img class="logo" src="icons/icon48.png" width="24" height="24" alt=""> <span data-i18n="optionsHeading">MixAI Connector settings</span></h1>

    <div class="field">
        <label for="libraryUrl" data-i18n="libraryUrlLabel">MixAI library address</label>
        <input type="url" id="libraryUrl" placeholder="https://app.mixai.ro">
        <div class="hint" data-i18n="libraryUrlHint">Where your MixAI library opens (default: https://app.mixai.ro).</div>
    </div>

    <button class="btn-save" id="save" data-i18n="save">Save settings</button>
    <span class="saved-msg" id="saved-msg" role="status" data-i18n="saved">✓ Saved</span>

    <script src="vendor/browser-polyfill.min.js"></script>
    <script src="i18n.js"></script>
    <script src="options.js"></script>`);

copyFileSync(path.join(here, "popup.js"), path.join(out, "popup.js"));
copyFileSync(path.join(here, "options.js"), path.join(out, "options.js"));
for (const f of ["i18n.js", "tokens.css"]) copyFileSync(path.join(ext, f), path.join(out, f));
mkdirSync(path.join(out, "vendor"), { recursive: true });
copyFileSync(path.join(ext, "vendor", "browser-polyfill.min.js"), path.join(out, "vendor", "browser-polyfill.min.js"));
mkdirSync(path.join(out, "icons"), { recursive: true });
for (const f of readdirSync(path.join(ext, "icons")).filter((n) => n.endsWith(".png"))) {
    copyFileSync(path.join(ext, "icons", f), path.join(out, "icons", f));
}
for (const icon of Object.values(manifest.icons)) {
    if (!existsSync(path.join(out, icon))) throw new Error(`missing icon ${icon} (run node brand/scripts/build.mjs)`);
}

// Guard: nothing in the store edition may reference a download flow or a third-party site.
const banned = /\/download\?|youtube\.com|spotify\.com|tiktok\.com|soundcloud\.com|content\.js/i;
for (const f of ["manifest.json", "popup.html", "popup.js", "options.html", "options.js"]) {
    if (banned.test(readFileSync(path.join(out, f), "utf8"))) throw new Error(`store edition ${f} references a banned target`);
}

if (process.argv.includes("--zip")) {
    const zip = path.join(ext, "build", `mixai-connector-store-v${manifest.version}.zip`);
    rmSync(zip, { force: true });
    execFileSync("zip", ["-rq", zip, "."], { cwd: out, stdio: "inherit" });
    console.log(zip);
}
console.log(`store edition ${manifest.version} -> ${out}`);
