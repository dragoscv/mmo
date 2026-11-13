import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Executed directly by `node --experimental-strip-types`, which needs explicit
// extensions (unlike the bundler-resolved imports elsewhere in this package).
import { androidColorsXml, kotlinRoles, kotlinTokens, plainCss, prehydrateScript, swiftTokens, tailwindCss, tokensJson } from "./generate.ts";
import type { AndroidColorToken } from "./generate.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist");
mkdirSync(dist, { recursive: true });

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const out: Record<string, string> = {
  "tokens.css": tailwindCss(),
  "tokens.plain.css": plainCss(),
  "tokens.json": tokensJson(),
  "Tokens.kt": kotlinTokens(),
  "prehydrate.js": prehydrateScript(),
};
for (const [name, content] of Object.entries(out)) {
  writeFileSync(join(dist, name), lf(content) + "\n", { encoding: "utf8" });
  console.log(`wrote dist/${name} (${content.length} B)`);
}

// Mirror into consumers that cannot import from packages/ (generated, committed).
const repo = join(here, "..", "..", "..");
const mirrors: Array<[string, string]> = [
  ["Tokens.kt", join(repo, "apps", "tv-android", "app", "src", "main", "java", "ro", "mixai", "tv", "ui", "theme", "Tokens.kt")],
  ["tokens.plain.css", join(repo, "apps", "tv-tizen", "src", "tokens.css")],
  ["tokens.plain.css", join(repo, "apps", "extension", "tokens.css")],
  ["tokens.plain.css", join(repo, "apps", "native", "web", "tokens.css")],
  ["tokens.plain.css", join(repo, "apps", "music-desktop", "web", "tokens.css")],
  // Decks connected mode pages (served by the decks-remote crate; byte-compared by its tests/assets.rs).
  ["tokens.plain.css", join(repo, "apps", "mixai", "src-tauri", "crates", "decks-remote", "assets", "tokens.css")],
  // Live remote page (served by the live-remote crate; byte-compared by its tests/assets.rs).
  ["tokens.plain.css", join(repo, "apps", "live", "engine", "crates", "live-remote", "assets", "tokens.css")],
  // MixAI Server renderer: the splash in server/ui/index.html paints before the bundle loads.
  ["tokens.plain.css", join(repo, "server", "ui", "public", "tokens.plain.css")],
  ["prehydrate.js", join(repo, "apps", "web", "public", "prehydrate.js")],
  ["prehydrate.js", join(repo, "apps", "tv-tizen", "public", "prehydrate.js")],
  ["prehydrate.js", join(repo, "apps", "mixai", "public", "prehydrate.js")],
  ["prehydrate.js", join(repo, "server", "ui", "public", "prehydrate.js")],
];
for (const [name, target] of mirrors) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lf(out[name]!) + "\n", { encoding: "utf8" });
  console.log(`mirrored ${name} → ${target.replace(repo, "")}`);
}

// Phone + MixAI Music apps (WP16-46, WP17-41 D52): Kotlin tokens in the shared :mobile-common library.
const phoneKt = join(repo, "apps", "mobile-android-common", "src", "main", "java", "ro", "mixai", "mobile", "theme", "Tokens.kt");
mkdirSync(dirname(phoneKt), { recursive: true });
writeFileSync(phoneKt, lf(kotlinTokens("ro.mixai.mobile.theme", true)) + "\n", { encoding: "utf8" });
console.log(`mirrored Tokens.kt → ${phoneKt.replace(repo, "")}`);
// MixAI Decks skins (WP19-18): raw OKLCH roles + dimensions for runtime re-tinting.
const rolesKt = join(dirname(phoneKt), "TokenRoles.kt");
writeFileSync(rolesKt, lf(kotlinRoles("ro.mixai.mobile.theme")) + "\n", { encoding: "utf8" });
console.log(`mirrored TokenRoles.kt → ${rolesKt.replace(repo, "")}`);

// iOS / tvOS apps (WP16-47, WP17-42): SwiftUI tokens in the shared MixaiCore package (public, used by MixAI,
// MixAI TV and MixAI Music).
const iosSwift = join(repo, "apps", "ios", "MixaiCore", "Sources", "MixaiCore", "Theme", "Tokens.swift");
mkdirSync(dirname(iosSwift), { recursive: true });
writeFileSync(iosSwift, lf(swiftTokens()) + "\n", { encoding: "utf8" });
console.log(`mirrored Tokens.swift → ${iosSwift.replace(repo, "")}`);

// Android window / splash / widget colours (WP22-06): `res/values/colors.xml` per module, generated instead of
// hand-copied. Resource names are the ones each module already uses. Launcher icon colours are not here: the
// brand generator (brand/scripts/build.mjs) writes those drawables.
const WINDOW: Record<string, AndroidColorToken> = { bg: "background", accent: "primary", accent2: "brandCyanDark" };
const androidColors: Array<[string, Record<string, AndroidColorToken>]> = [
  ["apps/tv-android/app", { ...WINDOW, foreground: "foreground" }],
  ["apps/phone-android/app", { ...WINDOW, foreground: "foreground" }],
  ["apps/music-android/app", WINDOW],
  ["apps/music-android/wear", WINDOW],
  ["apps/keybpm-android/app", { ...WINDOW, widget_fg: "foreground" }],
  ["apps/keybpm-android/wear", WINDOW],
  ["apps/live-android/app", WINDOW],
  ["apps/live-android/wear", { ...WINDOW, fg: "foreground", danger: "destructive" }],
  ["apps/decks-android/app", { decks_bg: "background", decks_a: "brandDeckA", decks_b: "brandDeckB" }],
];
for (const [moduleDir, entries] of androidColors) {
  const target = join(repo, ...moduleDir.split("/"), "src", "main", "res", "values", "colors.xml");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lf(androidColorsXml(entries)) + "\n", { encoding: "utf8" });
  console.log(`generated colors.xml → ${target.replace(repo, "")}`);
}
