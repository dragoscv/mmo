/**
 * `.mixaipack` bridge — typed wrappers over the Rust pack commands
 * (src-tauri/src/pack.rs). Format spec: docs/decks/packs.md.
 *
 * A pack is a zip with `manifest.json` (+ `tokens.json` DTCG, `layouts/*.json`,
 * `assets/*`, optional `presets/*.json`) and `signature.json` =
 * Ed25519 over the SHA-256 of the canonical file list. Packs are declarative
 * data only: no JS, no CSS. Rust verifies the signature and every limit before
 * anything is stored; the UI only ever sees validated JSON.
 */

export type PackKind = "skin" | "layout" | "bundle" | "controller";

export type PackTrust = "official" | "verified" | "community" | "unsigned";

export interface PackManifest {
    /** Schema version. */
    v: 1;
    /** Reverse-DNS-ish slug, e.g. "ro.mixai.skin.neon". */
    id: string;
    name: string;
    version: string;
    kind: PackKind;
    author: string;
    description: string;
    /** Requires the Decks Pro entitlement to install. */
    pro: boolean;
    /** Relative paths inside the zip. */
    tokens?: string;
    layouts?: string[];
    presets?: string[];
    preview?: string;
    /** Font files declared by the pack (woff2 only). */
    fonts?: { family: string; file: string; weight?: number; style?: "normal" | "italic" }[];
}

/** DTCG subset accepted from packs (validated in Rust, colours as OKLCH or #rrggbb). */
export interface PackTokens {
    mode?: "dark" | "light";
    accent?: string;
    surface?: "glass" | "solid" | "flat";
    density?: "comfortable" | "compact";
    radius?: "sm" | "md" | "lg";
    /** CSS custom property name (without --) -> colour value; only names on the allow-list. */
    colors?: Record<string, string>;
    /** Deck identity colour overrides (a..d), e.g. colour-blind palettes. */
    decks?: Partial<Record<"a" | "b" | "c" | "d", string>>;
    fontHeading?: string;
    fontBody?: string;
    /** Optional background image asset path. */
    background?: string;
}

export interface PackInfo {
    manifest: PackManifest;
    trust: PackTrust;
    /** SHA-256 hex of the archive. */
    sha256: string;
    /** Bytes. */
    size: number;
    installedAt?: number;
    tokens?: PackTokens;
    /** Raw layout JSON objects (validated again by the TS layout validator). */
    layouts?: unknown[];
    /** data: URL of the preview image, if any (<= 512 KB). */
    previewDataUrl?: string;
    /** asset path -> data: URL, only for images/fonts the tokens reference. */
    assets?: Record<string, string>;
}

function inTauri(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array): Promise<T | null> {
    if (!inTauri()) return null;
    const { invoke: inv } = await import("@tauri-apps/api/core");
    return inv<T>(cmd, args);
}

/** `pack_pick_file` answers a raw ArrayBuffer; empty = dialog cancelled. */
export function pickedBytes(buf: ArrayBuffer | null): Uint8Array | null {
    return buf && buf.byteLength > 0 ? new Uint8Array(buf) : null;
}

// Pack bytes go over IPC as a raw binary body, never as a JSON number array (a 25 MB pack would
// be ~100 MB of text). Rust refuses a JSON body for these commands.
export const packs = {
    /** Validate + verify a pack from bytes without installing it (used for the 30 s try). */
    inspect: (bytes: Uint8Array) => invoke<PackInfo>("pack_inspect", bytes),
    /** Validate, verify and store a pack in the app data dir. Throws a readable error string on refusal. */
    install: (bytes: Uint8Array) => invoke<PackInfo>("pack_install", bytes),
    list: () => invoke<PackInfo[]>("pack_list"),
    remove: (id: string) => invoke<void>("pack_remove", { id }),
    /** Pick a .mixaipack file from disk and return its bytes. */
    pickFile: () => invoke<ArrayBuffer>("pack_pick_file").then(pickedBytes),
};
