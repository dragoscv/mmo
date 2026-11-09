import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Executed directly by `node --experimental-strip-types`, which needs explicit
// extensions (unlike the bundler-resolved imports elsewhere in this package).
import { kotlinRoles, kotlinTokens, plainCss, prehydrateScript, swiftTokens, tailwindCss, tokensJson } from "./generate.ts";

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
