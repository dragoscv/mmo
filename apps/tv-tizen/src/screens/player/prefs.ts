/**
 * Per-profile playback preferences (`Profile.prefs`, merged server-side on PATCH). Same keys as tv-android
 * `ui/profiles/ProfileAdmin.kt` `ProfilePrefKeys`, so a profile edited on one TV behaves the same on the other.
 */
import type { Profile } from "../../lib/media-types";

export type SubSize = "small" | "medium" | "large" | "xlarge";
export type SubBg = "none" | "shadow" | "box";

export interface PlayerPrefs {
    autoplayNext: boolean;
    skipIntro: boolean;
    /** ISO 639-1 ("" = file default). */
    audioLang: string;
    /** ISO 639-1 ("" = automatic: forced track only). */
    subLang: string;
    subForcedOnly: boolean;
    subSize: SubSize;
    subBg: SubBg;
}

export const PREF_KEYS = {
    autoplayNext: "autoplayNext",
    skipIntro: "skipIntro",
    audioLang: "audioLang",
    subLang: "subLang",
    subForcedOnly: "subForcedOnly",
    subSize: "subSize",
    subBg: "subBg",
} as const;

export const SUB_SIZES: readonly SubSize[] = ["small", "medium", "large", "xlarge"];
export const SUB_BGS: readonly SubBg[] = ["none", "shadow", "box"];

/** Languages offered in Settings (same list as tv-android `SettingsSections.kt`). Endonyms need no i18n. */
export const LANGS: ReadonlyArray<{ code: string; name: string }> = [
    { code: "ro", name: "Română" }, { code: "en", name: "English" }, { code: "fr", name: "Français" },
    { code: "de", name: "Deutsch" }, { code: "es", name: "Español" }, { code: "it", name: "Italiano" },
    { code: "hu", name: "Magyar" }, { code: "pt", name: "Português" }, { code: "nl", name: "Nederlands" },
    { code: "pl", name: "Polski" }, { code: "tr", name: "Türkçe" }, { code: "ja", name: "日本語" }, { code: "ko", name: "한국어" },
];

export const DEFAULT_PREFS: PlayerPrefs = {
    autoplayNext: true, skipIntro: false, audioLang: "", subLang: "", subForcedOnly: false, subSize: "medium", subBg: "shadow",
};

const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);
const strv = (v: unknown, d: string): string => (typeof v === "string" ? v : d);

export function readPlayerPrefs(p: Profile | null | undefined): PlayerPrefs {
    const prefs = p?.prefs ?? {};
    // Legacy key "autoplay" wins only when the new one was never written (tv-android does the same).
    const legacy = prefs.autoplayNext === undefined && typeof prefs.autoplay === "boolean" ? prefs.autoplay : undefined;
    const size = strv(prefs.subSize, DEFAULT_PREFS.subSize);
    const bg = strv(prefs.subBg, DEFAULT_PREFS.subBg);
    return {
        autoplayNext: legacy ?? bool(prefs.autoplayNext, DEFAULT_PREFS.autoplayNext),
        skipIntro: bool(prefs.skipIntro, DEFAULT_PREFS.skipIntro),
        audioLang: strv(prefs.audioLang, ""),
        subLang: strv(prefs.subLang, ""),
        subForcedOnly: bool(prefs.subForcedOnly, false),
        subSize: (SUB_SIZES as readonly string[]).includes(size) ? (size as SubSize) : DEFAULT_PREFS.subSize,
        subBg: (SUB_BGS as readonly string[]).includes(bg) ? (bg as SubBg) : DEFAULT_PREFS.subBg,
    };
}

const ISO3: Record<string, string> = {
    ron: "ro", rum: "ro", eng: "en", fre: "fr", fra: "fr", ger: "de", deu: "de", spa: "es", ita: "it", hun: "hu",
    por: "pt", dut: "nl", nld: "nl", pol: "pl", tur: "tr", jpn: "ja", kor: "ko", rus: "ru", ukr: "uk", chi: "zh", zho: "zh",
};

/** "ron" / "ro-RO" / "RUM" → "ro". */
export function normLang(l: string | null | undefined): string {
    const s = (l ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
    return ISO3[s] ?? s;
}

export function langName(code: string): string {
    const n = normLang(code);
    return LANGS.find((l) => l.code === n)?.name ?? (n ? n.toUpperCase() : "");
}
