// winget manifest for MixAI Server (Companion) from a published GitHub release (WP17-52).
//   node scripts/winget-manifest.mjs [version]   -> packaging/winget/manifests/m/MixAI/Server/<version>/*.yaml
// Reads the NSIS installer asset of release v<version> (default: server/package.json version), downloads it to hash
// it (SHA-256, as winget requires), and writes the 3-file multi-manifest (version, installer, defaultLocale en-US).
// Submit by opening a PR to microsoft/winget-pkgs with that folder (wingetcreate submit works too).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "server/package.json"), "utf8"));
const version = process.argv[2] ?? pkg.version;
const id = "MixAI.Server";
const repo = "dragoscv/mmo";

const rel = await fetch(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, { headers: { accept: "application/vnd.github+json" } });
if (!rel.ok) throw new Error(`release v${version}: HTTP ${rel.status}`);
const asset = (await rel.json()).assets.find((a) => /Setup-.*\.exe$/.test(a.name));
if (!asset) throw new Error(`release v${version} has no *Setup-*.exe asset`);
const bin = await fetch(asset.browser_download_url);
if (!bin.ok) throw new Error(`download ${asset.name}: HTTP ${bin.status}`);
const sha = createHash("sha256").update(Buffer.from(await bin.arrayBuffer())).digest("hex").toUpperCase();

const dir = path.join(root, "packaging/winget/manifests/m/MixAI/Server", version);
mkdirSync(dir, { recursive: true });
const head = (type) => `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.10.0.schema.json\n`;
writeFileSync(path.join(dir, `${id}.yaml`), `${head("version")}
PackageIdentifier: ${id}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.10.0
`);
writeFileSync(path.join(dir, `${id}.installer.yaml`), `${head("installer")}
PackageIdentifier: ${id}
PackageVersion: ${version}
InstallerType: nullsoft
Scope: user
InstallModes:
  - silent
  - silentWithProgress
UpgradeBehavior: install
ReleaseDate: ${String((await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/v${version}`)).json()).published_at).slice(0, 10)}
Installers:
  - Architecture: x64
    InstallerUrl: ${asset.browser_download_url}
    InstallerSha256: ${sha}
ManifestType: installer
ManifestVersion: 1.10.0
`);
writeFileSync(path.join(dir, `${id}.locale.en-US.yaml`), `${head("defaultLocale")}
PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: Dragos Catalin Vladulescu
PublisherUrl: https://mixai.ro
PublisherSupportUrl: https://github.com/${repo}/issues
PrivacyUrl: https://mixai.ro/privacy?lang=en
PackageName: MixAI Server
PackageUrl: https://mixai.ro
License: AGPL-3.0-or-later
LicenseUrl: https://github.com/${repo}/blob/main/LICENSE
ShortDescription: Self-hosted media server for the MixAI apps (TV, Music, Studio, DJ).
Description: MixAI Server (MixAI Companion) serves your own movies, series, music, Live TV sources and recordings to the MixAI apps on TVs, phones, desktop and the web. Your library stays on your computer.
Moniker: mixai-server
Tags:
  - media-server
  - music
  - movies
  - self-hosted
  - streaming
ReleaseNotesUrl: https://github.com/${repo}/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: 1.10.0
`);
console.log(`${dir}\n${asset.name} sha256 ${sha}`);
