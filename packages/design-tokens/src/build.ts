import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// Executed directly by `node --experimental-strip-types`, which needs explicit
// extensions (unlike the bundler-resolved imports elsewhere in this package).
import { kotlinTokens, plainCss, prehydrateScript, swiftTokens, tailwindCss, tokensJson } from "./generate.ts";

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

// Phone app (WP16-46): same Kotlin tokens in the phone package.
const phoneKt = join(repo, "apps", "phone-android", "app", "src", "main", "java", "ro", "mixai", "app", "ui", "theme", "Tokens.kt");
mkdirSync(dirname(phoneKt), { recursive: true });
writeFileSync(phoneKt, lf(kotlinTokens("ro.mixai.app.ui.theme", true)) + "\n", { encoding: "utf8" });
console.log(`mirrored Tokens.kt → ${phoneKt.replace(repo, "")}`);

// iOS app (WP16-47): SwiftUI tokens.
const iosSwift = join(repo, "apps", "ios", "MixAI", "Theme", "Tokens.swift");
mkdirSync(dirname(iosSwift), { recursive: true });
writeFileSync(iosSwift, lf(swiftTokens()) + "\n", { encoding: "utf8" });
console.log(`mirrored Tokens.swift → ${iosSwift.replace(repo, "")}`);
