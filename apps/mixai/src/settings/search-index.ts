/**
 * Static search index of every setting row. Each row in a tab renders
 * `data-setting-id={id}` so a result can scroll it into view. Pure module
 * (no React, no aliases): unit-tested with node --test.
 *
 * `labelKey` is an i18n key; the modal translates it. Keywords are EN + RO,
 * lower-case, without diacritics (the query is folded the same way).
 */

/** Mirror of SETTINGS_TABS in state/ui-store.ts (kept local to stay pure). */
export type SettingsTabId =
    | "appearance"
    | "layout"
    | "audio"
    | "controllers"
    | "keyboard"
    | "library"
    | "plugins"
    | "marketplace"
    | "profiles"
    | "about";

export interface SettingEntry {
    id: string;
    tab: SettingsTabId;
    labelKey: string;
    keywords: string[];
}

export const SETTINGS_INDEX: readonly SettingEntry[] = [
    { id: "appearance.theme", tab: "appearance", labelKey: "settings.appearance", keywords: ["theme", "mode", "dark", "light", "accent", "colour", "color", "surface", "density", "radius", "motion", "animation", "tema", "culoare", "intunecat", "luminos", "animatii"] },
    { id: "appearance.language", tab: "appearance", labelKey: "settings.language", keywords: ["language", "locale", "romanian", "english", "limba", "romana", "engleza"] },
    { id: "appearance.extras", tab: "appearance", labelKey: "settings.appearanceExtras", keywords: ["skin", "colour blind", "touch", "beat accent", "performance", "governor", "daltonism", "tactil"] },
    { id: "appearance.skin", tab: "appearance", labelKey: "pack.skinTitle", keywords: ["skin", "theme pack", "look", "booth", "studio", "try", "tema", "aspect", "incearca"] },
    { id: "appearance.skinFile", tab: "appearance", labelKey: "pack.installFile", keywords: ["install", "file", "mixaipack", "pack", "import skin", "instaleaza", "fisier", "pachet"] },
    { id: "appearance.decks", tab: "appearance", labelKey: "settings.decksTitle", keywords: ["decks", "deck display", "afisare deck"] },
    { id: "appearance.booth", tab: "appearance", labelKey: "settings.boothMode", keywords: ["booth", "big readouts", "large numbers", "distance", "cabina", "cifre mari", "de la distanta"] },
    { id: "appearance.platter", tab: "appearance", labelKey: "settings.platter", keywords: ["platter", "vinyl", "jog", "turntable", "platan", "vinil", "pick-up"] },
    { id: "appearance.cuePalette", tab: "appearance", labelKey: "settings.cuePalette", keywords: ["hot cue", "cue colours", "cue colors", "colour blind", "color blind", "daltonism", "culori cue"] },
    { id: "appearance.deckPalette", tab: "appearance", labelKey: "pack.paletteTitle", keywords: ["deck colours", "deck colors", "colour blind", "color blind", "deuteranopia", "protanopia", "tritanopia", "monochrome", "daltonism", "culori deck", "monocrom"] },
    { id: "appearance.highContrast", tab: "appearance", labelKey: "pack.highContrast", keywords: ["high contrast", "accessibility", "low vision", "contrast ridicat", "accesibilitate"] },
    { id: "appearance.touch", tab: "appearance", labelKey: "pack.touch", keywords: ["touch", "tablet", "44 px", "fingers", "big buttons", "tactil", "ecran tactil", "butoane mari"] },
    { id: "appearance.beatAccent", tab: "appearance", labelKey: "pack.beatAccent", keywords: ["beat", "pulse", "accent", "glow", "clock", "ritm", "pulsatie", "stralucire"] },
    { id: "appearance.hud", tab: "appearance", labelKey: "pack.hud", keywords: ["hud", "fps", "frame rate", "performance", "audio load", "performanta", "cadre"] },
    { id: "appearance.governor", tab: "appearance", labelKey: "pack.governor", keywords: ["governor", "animations", "fps", "frame budget", "slow", "limitator", "animatii"] },
    { id: "layout.list", tab: "layout", labelKey: "settings.layoutList", keywords: ["layout", "grid", "classic", "performance", "four deck", "ultrawide", "panels", "aranjament", "panouri"] },
    { id: "layout.snapshots", tab: "layout", labelKey: "settings.layoutSnapshots", keywords: ["snapshot", "slot", "alt+1", "switch layout", "instantaneu"] },
    { id: "layout.controllers", tab: "layout", labelKey: "settings.layoutControllers", keywords: ["controller layout", "device", "auto", "consola", "dispozitiv"] },
    { id: "layout.editor", tab: "layout", labelKey: "settings.layoutEdit", keywords: ["edit", "editor", "custom layout", "editeaza"] },
    { id: "audio.master", tab: "audio", labelKey: "settings.audioOut", keywords: ["output", "master", "sound card", "device", "speakers", "iesire", "placa de sunet", "boxe"] },
    { id: "audio.cue", tab: "audio", labelKey: "settings.cueOut", keywords: ["cue", "headphones", "pfl", "monitor", "casti"] },
    { id: "audio.latency", tab: "audio", labelKey: "settings.latency", keywords: ["latency", "delay", "booth", "compensation", "ms", "latenta", "intarziere"] },
    { id: "controllers.midi", tab: "controllers", labelKey: "settings.midi", keywords: ["midi", "controller", "mapping", "learn", "ddj", "flx4", "preset", "consola", "mapare"] },
    { id: "controllers.ble", tab: "controllers", labelKey: "settings.ble", keywords: ["bluetooth", "ble", "wireless", "midi", "fara fir"] },
    { id: "controllers.hid", tab: "controllers", labelKey: "settings.hid", keywords: ["hid", "cdj", "usb", "jog", "controller"] },
    { id: "keyboard.shortcuts", tab: "keyboard", labelKey: "settings.keyboardOpen", keywords: ["keyboard", "shortcuts", "keys", "hotkeys", "bind", "tastatura", "scurtaturi", "taste"] },
    { id: "library.companion", tab: "library", labelKey: "settings.library", keywords: ["library", "server", "companion", "token", "pairing", "mixai.ro", "account", "biblioteca", "cont", "asociere"] },
    { id: "plugins.manager", tab: "plugins", labelKey: "settings.plugins", keywords: ["plugins", "extensions", "macro", "install", "pluginuri", "extensii"] },
    { id: "marketplace.store", tab: "marketplace", labelKey: "settings.tabMarketplace", keywords: ["marketplace", "store", "packs", "skins", "magazin", "pachete"] },
    { id: "marketplace.filters", tab: "marketplace", labelKey: "pack.search", keywords: ["search packs", "filter", "free", "pro", "layouts", "bundles", "cauta", "gratuite", "aranjamente"] },
    { id: "profiles.list", tab: "profiles", labelKey: "settings.profilesTitle", keywords: ["profile", "home", "club", "streaming", "switch", "profil", "acasa"] },
    { id: "profiles.file", tab: "profiles", labelKey: "settings.fileTitle", keywords: ["export", "import", "file", "json", "backup", "fisier", "copie de rezerva"] },
    { id: "profiles.backup", tab: "profiles", labelKey: "settings.profile", keywords: ["backup", "cloud", "sync", "restore", "sincronizare", "restaurare"] },
    { id: "about.version", tab: "about", labelKey: "settings.aboutVersion", keywords: ["version", "about", "engine", "licence", "license", "agpl", "versiune", "despre", "licenta"] },
    { id: "about.updates", tab: "about", labelKey: "settings.aboutUpdates", keywords: ["update", "updates", "store", "winget", "actualizari"] },
    { id: "about.tour", tab: "about", labelKey: "pack.tourAgain", keywords: ["tour", "welcome", "onboarding", "tutorial", "intro", "tur", "bun venit", "ghid"] },
];

/** Lower-case and strip diacritics (ă â î ș ț → a a i s t). */
export function fold(s: string): string {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Entries matching every word of the query against the translated label,
 * the tab label and the keywords. Empty query = no results.
 */
export function searchSettings(
    query: string,
    label: (key: string) => string,
    tabLabel: (tab: SettingsTabId) => string = (t) => t,
): SettingEntry[] {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return SETTINGS_INDEX.filter((e) => {
        const hay = fold([label(e.labelKey), tabLabel(e.tab), ...e.keywords].join(" "));
        return words.every((w) => hay.includes(w));
    });
}
