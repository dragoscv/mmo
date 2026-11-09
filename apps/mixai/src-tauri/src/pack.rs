//! `.mixaipack` packs: validation, Ed25519 verification, storage. Format: docs/decks/packs.md.
//! TS contract: src/bridge/packs.ts (serde camelCase must match it exactly).
//!
//! A pack is declarative data only (JSON + images + woff2 fonts). Everything is validated here
//! before the UI sees it; anything unexpected is refused with a readable English error string.

use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

// ---- limits -------------------------------------------------------------------

pub const MAX_ARCHIVE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 200;
pub const MAX_ENTRY_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 60 * 1024 * 1024;
pub const MAX_RATIO: u64 = 100;
/// Entries smaller than this skip the ratio check (tiny repetitive JSON compresses very well).
pub const RATIO_MIN_BYTES: u64 = 64 * 1024;
pub const MAX_LAYOUT_BYTES: usize = 64 * 1024;
pub const MAX_PREVIEW_BYTES: usize = 512 * 1024;
/// Fonts + background are inlined as data: URLs and cross IPC on every list: keep them small.
pub const MAX_INLINE_ASSET_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_FONTS: usize = 8;
/// Id prefix and author name reserved for packs signed with an official key.
pub const RESERVED_ID_PREFIX: &str = "ro.mixai.";
pub const RESERVED_AUTHOR: &str = "mixai";

fn trust_rank(t: PackTrust) -> u8 {
    match t {
        PackTrust::Official => 3,
        PackTrust::Verified => 2,
        PackTrust::Community => 1,
        PackTrust::Unsigned => 0,
    }
}
const ALLOWED_EXT: &[&str] = &["json", "png", "jpg", "jpeg", "webp", "avif", "woff2"];
const IMAGE_EXT: &[&str] = &["png", "jpg", "jpeg", "webp", "avif"];
pub const SIGNATURE_FILE: &str = "signature.json";
pub const MANIFEST_FILE: &str = "manifest.json";

/// CSS custom property names a pack may override.
pub const COLOR_KEYS: &[&str] = &[
    "background",
    "foreground",
    "card",
    "card-foreground",
    "popover",
    "popover-foreground",
    "primary",
    "primary-foreground",
    "secondary",
    "secondary-foreground",
    "muted",
    "muted-foreground",
    "accent",
    "accent-foreground",
    "destructive",
    "border",
    "input",
    "ring",
    "deck-a",
    "deck-b",
    "deck-c",
    "deck-d",
    "success",
    "warning",
];

// ---- trust keys ---------------------------------------------------------------

/// `(keyId, Ed25519 public key)`.
pub type TrustKey = (&'static str, [u8; 32]);

/// MixAI's own signing keys. The private key of `mixai-official-2026` lives outside the repo
/// (see docs/decks/packs.md); only the public half is compiled in.
pub const OFFICIAL_KEYS: &[TrustKey] = &[(
    "mixai-official-2026",
    [
        0xda, 0xaf, 0x39, 0x2e, 0xb3, 0xc6, 0x9f, 0xb8, 0x63, 0xd8, 0x32, 0xb5, 0xba, 0x4e, 0xb9,
        0xc6, 0xc3, 0x24, 0xbe, 0xed, 0x98, 0xd6, 0xad, 0x77, 0x41, 0xc0, 0x81, 0x64, 0x40, 0xf7,
        0xf5, 0x74,
    ],
)];

/// Keys of vetted third-party creators (empty until the creator programme starts).
pub const VERIFIED_KEYS: &[TrustKey] = &[];

pub struct KeyTables<'a> {
    pub official: &'a [TrustKey],
    pub verified: &'a [TrustKey],
}

pub const BUILTIN_KEYS: KeyTables<'static> = KeyTables {
    official: OFFICIAL_KEYS,
    verified: VERIFIED_KEYS,
};

// ---- contract types (mirror src/bridge/packs.ts) ------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackKind {
    Skin,
    Layout,
    Bundle,
    Controller,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackTrust {
    Official,
    Verified,
    Community,
    Unsigned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FontStyle {
    Normal,
    Italic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackFont {
    pub family: String,
    pub file: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<FontStyle>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackManifest {
    pub v: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: PackKind,
    pub author: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub pro: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layouts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presets: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fonts: Option<Vec<PackFont>>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackTokens {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub density: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub radius: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colors: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decks: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_heading: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInfo {
    pub manifest: PackManifest,
    pub trust: PackTrust,
    pub sha256: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<PackTokens>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layouts: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assets: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignatureFile {
    alg: String,
    key_id: String,
    sig: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pubkey: Option<String>,
}

// ---- small helpers ------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(H[(b >> 4) as usize] as char);
        s.push(H[(b & 0xf) as usize] as char);
    }
    s
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn ext_of(name: &str) -> Option<String> {
    let file = name.rsplit('/').next()?;
    let (_, ext) = file.rsplit_once('.')?;
    Some(ext.to_ascii_lowercase())
}

fn mime_of(name: &str) -> &'static str {
    match ext_of(name).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("woff2") => "font/woff2",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

fn data_url(name: &str, bytes: &[u8]) -> String {
    format!("data:{};base64,{}", mime_of(name), B64.encode(bytes))
}

fn short(s: &str) -> String {
    s.chars().take(80).collect()
}

/// Entry names: relative, `/`-separated, no `..`/`.`/empty segments, no backslash, no drive.
fn validate_entry_name(name: &str) -> Result<(), String> {
    let bad = |why: &str| Err(format!("invalid entry name '{}': {why}", short(name)));
    if name.is_empty() || name.len() > 200 {
        return bad("empty or longer than 200 bytes");
    }
    if name.starts_with('/') {
        return bad("absolute path");
    }
    if name.contains('\\') {
        return bad("backslash");
    }
    if name.contains(':') {
        return bad("drive or stream separator");
    }
    if name.chars().any(|c| c.is_control()) {
        return bad("control character");
    }
    let trimmed = name.strip_suffix('/').unwrap_or(name);
    for seg in trimmed.split('/') {
        if seg.is_empty() || seg == "." || seg == ".." {
            return bad("empty, '.' or '..' segment");
        }
    }
    Ok(())
}

/// Pack id: `^[a-z0-9]+(\.[a-z0-9-]+){1,6}$`, at most 100 chars.
pub fn valid_pack_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 100 {
        return false;
    }
    let segs: Vec<&str> = id.split('.').collect();
    if !(2..=7).contains(&segs.len()) {
        return false;
    }
    let first_ok = segs[0]
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    first_ok
        && !segs[0].is_empty()
        && segs[1..].iter().all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

fn valid_font_family(f: &str) -> bool {
    (1..=40).contains(&f.len())
        && f.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-')
}

/// Plain decimal number (optionally signed / fractional); no exponents, no units.
fn parse_num(s: &str) -> Option<f64> {
    let body = s.strip_prefix('-').unwrap_or(s);
    if body.is_empty()
        || body.len() > 12
        || !body.bytes().all(|b| b.is_ascii_digit() || b == b'.')
        || body.bytes().filter(|b| *b == b'.').count() > 1
        || body == "."
    {
        return None;
    }
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Number or percentage, normalised so that 100 % == `pct_scale`.
fn parse_num_pct(s: &str, pct_scale: f64) -> Option<f64> {
    match s.strip_suffix('%') {
        Some(p) => parse_num(p).map(|v| v / 100.0 * pct_scale),
        None => parse_num(s),
    }
}

/// `#rrggbb`, `#rrggbbaa`, `oklch(L C H)` or `oklch(L C H / A)` with sane bounds. Nothing else.
pub fn valid_color(c: &str) -> bool {
    if let Some(h) = c.strip_prefix('#') {
        return (h.len() == 6 || h.len() == 8) && h.bytes().all(|b| b.is_ascii_hexdigit());
    }
    let Some(inner) = c.strip_prefix("oklch(").and_then(|r| r.strip_suffix(')')) else {
        return false;
    };
    let (lch, alpha) = match inner.split_once('/') {
        Some((a, b)) => (a, Some(b.trim())),
        None => (inner, None),
    };
    let parts: Vec<&str> = lch.split_whitespace().collect();
    if parts.len() != 3 {
        return false;
    }
    let l = parse_num_pct(parts[0], 1.0);
    let ch = parse_num(parts[1]);
    let h = parse_num(parts[2]);
    let ok_lch = matches!(l, Some(v) if (0.0..=1.0).contains(&v))
        && matches!(ch, Some(v) if (0.0..=0.5).contains(&v))
        && matches!(h, Some(v) if (0.0..=360.0).contains(&v));
    let ok_a = match alpha {
        None => true,
        Some(a) => matches!(parse_num_pct(a, 1.0), Some(v) if (0.0..=1.0).contains(&v)),
    };
    ok_lch && ok_a
}

fn check_len(field: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    let n = value.chars().count();
    if n < min || n > max {
        return Err(format!(
            "manifest.{field} must be {min}..{max} characters (got {n})"
        ));
    }
    Ok(())
}

// ---- archive reading ----------------------------------------------------------

struct Archive {
    /// file name -> bytes, sorted by name (directories skipped).
    files: BTreeMap<String, Vec<u8>>,
}

fn read_archive(bytes: &[u8]) -> Result<Archive, String> {
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "pack is too large ({} bytes, limit {MAX_ARCHIVE_BYTES})",
            bytes.len()
        ));
    }
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a valid zip: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!(
            "pack has too many entries ({}, limit {MAX_ENTRIES})",
            zip.len()
        ));
    }
    let mut files = BTreeMap::new();
    let mut seen = HashSet::new();
    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut f = zip
            .by_index(i)
            .map_err(|e| format!("cannot read zip entry {i}: {e}"))?;
        let name = f
            .name()
            .map_err(|_| format!("zip entry {i} has a name that is not valid UTF-8"))?
            .into_owned();
        validate_entry_name(&name)?;
        if !seen.insert(name.clone()) {
            return Err(format!("duplicate entry '{}'", short(&name)));
        }
        if f.is_symlink() {
            return Err(format!("symlinks are not allowed ('{}')", short(&name)));
        }
        if f.encrypted() {
            return Err(format!(
                "encrypted entries are not allowed ('{}')",
                short(&name)
            ));
        }
        if f.is_dir() {
            continue;
        }
        match ext_of(&name) {
            Some(e) if ALLOWED_EXT.contains(&e.as_str()) => {}
            _ => {
                return Err(format!(
                    "file type not allowed: '{}' (allowed: {})",
                    short(&name),
                    ALLOWED_EXT.join(", ")
                ));
            }
        }
        if !matches!(
            f.compression(),
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
        ) {
            return Err(format!(
                "unsupported compression for '{}' (use deflate or store)",
                short(&name)
            ));
        }
        let size = f.size();
        if size > MAX_ENTRY_BYTES {
            return Err(format!(
                "entry '{}' is too large ({size} bytes, limit {MAX_ENTRY_BYTES})",
                short(&name)
            ));
        }
        let comp = f.compressed_size().max(1);
        if size >= RATIO_MIN_BYTES && size / comp > MAX_RATIO {
            return Err(format!(
                "entry '{}' compression ratio {} exceeds {MAX_RATIO} (zip bomb guard)",
                short(&name),
                size / comp
            ));
        }
        total += size;
        if total > MAX_TOTAL_BYTES {
            return Err(format!(
                "pack uncompressed size exceeds {MAX_TOTAL_BYTES} bytes"
            ));
        }
        // Never trust the header: cap the actual read too.
        let mut buf = Vec::with_capacity(size as usize);
        (&mut f)
            .take(MAX_ENTRY_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot decompress '{}': {e}", short(&name)))?;
        if buf.len() as u64 != size {
            return Err(format!("entry '{}' size mismatch", short(&name)));
        }
        files.insert(name, buf);
    }
    Ok(Archive { files })
}

/// SHA-256 over `<name>\n<sha256 hex>\n` for every file except signature.json, sorted by name.
fn canonical_digest(files: &BTreeMap<String, Vec<u8>>) -> [u8; 32] {
    let mut h = Sha256::new();
    for (name, bytes) in files {
        if name == SIGNATURE_FILE {
            continue;
        }
        h.update(name.as_bytes());
        h.update(b"\n");
        h.update(hex(&sha256(bytes)).as_bytes());
        h.update(b"\n");
    }
    h.finalize().into()
}

fn decode_key(b64: &str, what: &str) -> Result<[u8; 32], String> {
    let raw = B64
        .decode(b64.trim())
        .map_err(|_| format!("signature.json: {what} is not valid base64"))?;
    raw.try_into()
        .map_err(|_| format!("signature.json: {what} must be 32 bytes"))
}

fn verify_signature(archive: &Archive, keys: &KeyTables<'_>) -> Result<PackTrust, String> {
    let Some(raw) = archive.files.get(SIGNATURE_FILE) else {
        return Ok(PackTrust::Unsigned);
    };
    let sig: SignatureFile =
        serde_json::from_slice(raw).map_err(|e| format!("signature.json is malformed: {e}"))?;
    if sig.alg != "ed25519" {
        return Err(format!(
            "unsupported signature algorithm '{}'",
            short(&sig.alg)
        ));
    }
    let lookup = |table: &[TrustKey]| {
        table
            .iter()
            .find(|(id, _)| *id == sig.key_id)
            .map(|(_, k)| *k)
    };
    let (key, trust) = if let Some(k) = lookup(keys.official) {
        (k, PackTrust::Official)
    } else if let Some(k) = lookup(keys.verified) {
        (k, PackTrust::Verified)
    } else if let Some(pk) = sig.pubkey.as_deref() {
        (decode_key(pk, "pubkey")?, PackTrust::Community)
    } else {
        return Err(format!(
            "unknown signing key '{}' and no embedded public key",
            short(&sig.key_id)
        ));
    };
    let vk = VerifyingKey::from_bytes(&key).map_err(|_| "invalid public key".to_string())?;
    let sig_raw = B64
        .decode(sig.sig.trim())
        .map_err(|_| "signature.json: sig is not valid base64".to_string())?;
    let sig_bytes: [u8; 64] = sig_raw
        .try_into()
        .map_err(|_| "signature.json: sig must be 64 bytes".to_string())?;
    let signature = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(&canonical_digest(&archive.files), &signature)
        .map_err(|_| "pack signature is invalid (modified after signing?)".to_string())?;
    Ok(trust)
}

// ---- manifest + tokens ------------------------------------------------------------

fn require_file(archive: &Archive, field: &str, path: &str, exts: &[&str]) -> Result<(), String> {
    validate_entry_name(path)?;
    match ext_of(path) {
        Some(e) if exts.contains(&e.as_str()) => {}
        _ => {
            return Err(format!(
                "{field} '{}' must be one of: {}",
                short(path),
                exts.join(", ")
            ));
        }
    }
    if !archive.files.contains_key(path) {
        return Err(format!(
            "{field} '{}' is missing from the pack",
            short(path)
        ));
    }
    Ok(())
}

fn validate_manifest(archive: &Archive) -> Result<PackManifest, String> {
    let raw = archive
        .files
        .get(MANIFEST_FILE)
        .ok_or("manifest.json is missing")?;
    let m: PackManifest =
        serde_json::from_slice(raw).map_err(|e| format!("manifest.json is invalid: {e}"))?;
    if m.v != 1 {
        return Err(format!("unsupported manifest version {} (expected 1)", m.v));
    }
    if !valid_pack_id(&m.id) {
        return Err(format!(
            "manifest.id '{}' must look like 'ro.mixai.skin.neon' (lowercase, dots, max 100)",
            short(&m.id)
        ));
    }
    check_len("name", &m.name, 1, 60)?;
    check_len("author", &m.author, 1, 60)?;
    check_len("description", &m.description, 0, 500)?;
    if !valid_version(&m.version) {
        return Err(format!(
            "manifest.version '{}' must be MAJOR.MINOR.PATCH",
            short(&m.version)
        ));
    }
    if let Some(t) = &m.tokens {
        require_file(archive, "manifest.tokens", t, &["json"])?;
    }
    for l in m.layouts.iter().flatten() {
        require_file(archive, "manifest.layouts", l, &["json"])?;
    }
    for p in m.presets.iter().flatten() {
        require_file(archive, "manifest.presets", p, &["json"])?;
    }
    if let Some(p) = &m.preview {
        require_file(archive, "manifest.preview", p, IMAGE_EXT)?;
    }
    for f in m.fonts.iter().flatten() {
        if !valid_font_family(&f.family) {
            return Err(format!("font family '{}' is not allowed", short(&f.family)));
        }
        require_file(archive, "font file", &f.file, &["woff2"])?;
        if let Some(w) = f.weight
            && !(100..=900).contains(&w)
        {
            return Err(format!("font weight {w} must be 100..900"));
        }
    }
    Ok(m)
}

fn str_field(obj: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("tokens.{key} must be a string")),
    }
}

fn one_of(key: &str, v: Option<String>, allowed: &[&str]) -> Result<Option<String>, String> {
    match v {
        Some(s) if !allowed.contains(&s.as_str()) => Err(format!(
            "tokens.{key} '{}' must be one of: {}",
            short(&s),
            allowed.join(", ")
        )),
        v => Ok(v),
    }
}

fn put_color(colors: &mut BTreeMap<String, String>, key: &str, value: &str) -> Result<(), String> {
    if !COLOR_KEYS.contains(&key) {
        return Err(format!("colour token '{}' is not allowed", short(key)));
    }
    if !valid_color(value) {
        return Err(format!(
            "colour '{}' for '{key}' must be #rrggbb, #rrggbbaa or oklch(L C H [/ A])",
            short(value)
        ));
    }
    colors.insert(key.to_owned(), value.to_owned());
    Ok(())
}

/// Accept the flat `PackTokens` shape and/or a DTCG `color` group (`{ "$value": ... }` leaves).
fn validate_tokens(archive: &Archive, path: &str) -> Result<PackTokens, String> {
    let raw = &archive.files[path];
    let v: Value =
        serde_json::from_slice(raw).map_err(|e| format!("{path} is not valid JSON: {e}"))?;
    let obj = v
        .as_object()
        .ok_or(format!("{path} must be a JSON object"))?;
    const KNOWN: &[&str] = &[
        "mode",
        "accent",
        "surface",
        "density",
        "radius",
        "colors",
        "decks",
        "fontHeading",
        "fontBody",
        "background",
        "color",
    ];
    for k in obj.keys() {
        if !k.starts_with('$') && !KNOWN.contains(&k.as_str()) {
            return Err(format!("unknown token '{}' in {path}", short(k)));
        }
    }
    let mut t = PackTokens {
        mode: one_of("mode", str_field(obj, "mode")?, &["dark", "light"])?,
        surface: one_of(
            "surface",
            str_field(obj, "surface")?,
            &["glass", "solid", "flat"],
        )?,
        density: one_of(
            "density",
            str_field(obj, "density")?,
            &["comfortable", "compact"],
        )?,
        radius: one_of("radius", str_field(obj, "radius")?, &["sm", "md", "lg"])?,
        ..PackTokens::default()
    };
    // Accent: a colour, or a named accent of the design system (lowercase slug).
    if let Some(a) = str_field(obj, "accent")? {
        let slug =
            (1..=24).contains(&a.len()) && a.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
        if !slug && !valid_color(&a) {
            return Err(format!(
                "tokens.accent '{}' must be a colour or an accent name",
                short(&a)
            ));
        }
        t.accent = Some(a);
    }
    let mut colors = BTreeMap::new();
    match obj.get("colors") {
        None | Some(Value::Null) => {}
        Some(Value::Object(m)) => {
            for (k, v) in m {
                let s = v
                    .as_str()
                    .ok_or(format!("colour '{}' must be a string", short(k)))?;
                put_color(&mut colors, k, s)?;
            }
        }
        Some(_) => return Err("tokens.colors must be an object".into()),
    }
    match obj.get("color") {
        None | Some(Value::Null) => {}
        Some(Value::Object(m)) => {
            for (k, v) in m {
                if k.starts_with('$') {
                    continue;
                }
                let s = v
                    .get("$value")
                    .and_then(Value::as_str)
                    .ok_or(format!("DTCG colour '{}' needs a string $value", short(k)))?;
                put_color(&mut colors, k, s)?;
            }
        }
        Some(_) => return Err("tokens.color must be a DTCG group object".into()),
    }
    if !colors.is_empty() {
        t.colors = Some(colors);
    }
    match obj.get("decks") {
        None | Some(Value::Null) => {}
        Some(Value::Object(m)) => {
            let mut decks = BTreeMap::new();
            for (k, v) in m {
                if !["a", "b", "c", "d"].contains(&k.as_str()) {
                    return Err(format!("tokens.decks key '{}' must be a..d", short(k)));
                }
                let s = v
                    .as_str()
                    .filter(|s| valid_color(s))
                    .ok_or(format!("tokens.decks.{k} must be a valid colour"))?;
                decks.insert(k.clone(), s.to_owned());
            }
            if !decks.is_empty() {
                t.decks = Some(decks);
            }
        }
        Some(_) => return Err("tokens.decks must be an object".into()),
    }
    for (key, slot) in [
        ("fontHeading", &mut t.font_heading),
        ("fontBody", &mut t.font_body),
    ] {
        if let Some(f) = str_field(obj, key)? {
            if !valid_font_family(&f) {
                return Err(format!("tokens.{key} '{}' is not allowed", short(&f)));
            }
            *slot = Some(f);
        }
    }
    if let Some(bg) = str_field(obj, "background")? {
        require_file(archive, "tokens.background", &bg, IMAGE_EXT)?;
        t.background = Some(bg);
    }
    Ok(t)
}

fn read_layout(archive: &Archive, path: &str) -> Result<Value, String> {
    let raw = &archive.files[path];
    if raw.len() > MAX_LAYOUT_BYTES {
        return Err(format!(
            "layout '{}' is larger than {MAX_LAYOUT_BYTES} bytes",
            short(path)
        ));
    }
    let v: Value = serde_json::from_slice(raw)
        .map_err(|e| format!("layout '{}' is not valid JSON: {e}", short(path)))?;
    if !v.is_object() {
        return Err(format!("layout '{}' must be a JSON object", short(path)));
    }
    Ok(v)
}

// ---- public API -------------------------------------------------------------------

/// Validate + verify a pack against the given key tables. Pure: no I/O.
pub fn inspect_with(bytes: &[u8], keys: &KeyTables<'_>) -> Result<PackInfo, String> {
    let archive = read_archive(bytes)?;
    let manifest = validate_manifest(&archive)?;
    let trust = verify_signature(&archive, keys)?;
    if trust != PackTrust::Official
        && (manifest.id.starts_with(RESERVED_ID_PREFIX)
            || manifest.author.trim().eq_ignore_ascii_case(RESERVED_AUTHOR))
    {
        return Err(format!(
            "ids starting with '{RESERVED_ID_PREFIX}' and the author 'MixAI' are reserved for official packs"
        ));
    }
    if manifest.fonts.as_ref().is_some_and(|f| f.len() > MAX_FONTS) {
        return Err(format!("at most {MAX_FONTS} fonts per pack"));
    }
    let tokens = manifest
        .tokens
        .as_deref()
        .map(|p| validate_tokens(&archive, p))
        .transpose()?;
    let layouts = manifest
        .layouts
        .as_ref()
        .map(|ls| ls.iter().map(|l| read_layout(&archive, l)).collect())
        .transpose()?;
    // Presets: must at least be JSON (the UI validates their schema).
    for p in manifest.presets.iter().flatten() {
        serde_json::from_slice::<Value>(&archive.files[p])
            .map_err(|e| format!("preset '{}' is not valid JSON: {e}", short(p)))?;
    }
    let preview_data_url = manifest.preview.as_deref().and_then(|p| {
        let b = &archive.files[p];
        (b.len() <= MAX_PREVIEW_BYTES).then(|| data_url(p, b))
    });
    let mut assets = BTreeMap::new();
    if let Some(bg) = tokens.as_ref().and_then(|t| t.background.as_deref()) {
        assets.insert(bg.to_owned(), data_url(bg, &archive.files[bg]));
    }
    for f in manifest.fonts.iter().flatten() {
        assets.insert(f.file.clone(), data_url(&f.file, &archive.files[&f.file]));
    }
    let inline: usize = assets.keys().map(|k| archive.files[k].len()).sum();
    if inline > MAX_INLINE_ASSET_BYTES {
        return Err(format!(
            "fonts + background are {} KB; the limit is {} KB",
            inline / 1024,
            MAX_INLINE_ASSET_BYTES / 1024
        ));
    }
    Ok(PackInfo {
        manifest,
        trust,
        sha256: hex(&sha256(bytes)),
        size: bytes.len() as u64,
        installed_at: None,
        tokens,
        layouts,
        preview_data_url,
        assets: (!assets.is_empty()).then_some(assets),
    })
}

pub fn inspect(bytes: &[u8]) -> Result<PackInfo, String> {
    inspect_with(bytes, &BUILTIN_KEYS)
}

/// Sign a pack: returns a new zip with every entry (except an old signature.json) plus a fresh
/// `signature.json` carrying `keyId` and the embedded public key. Used by tests and the Skin SDK.
// No app command signs packs (signing happens in CI / the Skin SDK), so it is unused outside tests.
#[cfg_attr(not(test), allow(dead_code))]
pub fn sign_pack(zip_bytes: &[u8], key: &SigningKey, key_id: &str) -> Result<Vec<u8>, String> {
    let mut archive = read_archive(zip_bytes)?;
    archive.files.remove(SIGNATURE_FILE);
    let digest = canonical_digest(&archive.files);
    let sig = SignatureFile {
        alg: "ed25519".into(),
        key_id: key_id.into(),
        sig: B64.encode(key.sign(&digest).to_bytes()),
        pubkey: Some(B64.encode(key.verifying_key().to_bytes())),
    };
    let sig_json = serde_json::to_vec_pretty(&sig).map_err(|e| e.to_string())?;
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let entries = archive
        .files
        .iter()
        .map(|(n, b)| (n.as_str(), b.as_slice()))
        .chain(std::iter::once((SIGNATURE_FILE, sig_json.as_slice())));
    for (name, bytes) in entries {
        w.start_file(name, opts).map_err(|e| e.to_string())?;
        w.write_all(bytes).map_err(|e| e.to_string())?;
    }
    Ok(w.finish().map_err(|e| e.to_string())?.into_inner())
}

// ---- storage ------------------------------------------------------------------------

/// Serialises index writes.
#[derive(Default)]
pub struct PackState(Mutex<()>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    sha256: String,
    installed_at: u64,
}

type Index = BTreeMap<String, IndexEntry>;

fn packs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("packs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn read_index(dir: &std::path::Path) -> Index {
    std::fs::read(dir.join("index.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

fn write_index(dir: &std::path::Path, index: &Index) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(index).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("index.json"), &bytes)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---- commands -------------------------------------------------------------------------

#[tauri::command]
pub async fn pack_inspect(bytes: Vec<u8>) -> Result<PackInfo, String> {
    inspect(&bytes)
}

#[tauri::command]
pub async fn pack_install(
    app: AppHandle,
    state: State<'_, PackState>,
    bytes: Vec<u8>,
) -> Result<PackInfo, String> {
    let mut info = inspect(&bytes)?;
    let dir = packs_dir(&app)?;
    let _guard = state.0.lock().map_err(|_| "pack store lock poisoned")?;
    let path = dir.join(format!("{}.mixaipack", info.manifest.id));
    // Never let a less trusted pack replace an installed one with the same id.
    if let Some(old) = std::fs::read(&path).ok().and_then(|b| inspect(&b).ok())
        && trust_rank(info.trust) < trust_rank(old.trust)
    {
        return Err(format!(
            "a more trusted pack with the id '{}' is already installed; remove it first",
            info.manifest.id
        ));
    }
    write_atomic(&path, &bytes)?;
    let mut index = read_index(&dir);
    let installed_at = now_ms();
    index.insert(
        info.manifest.id.clone(),
        IndexEntry {
            sha256: info.sha256.clone(),
            installed_at,
        },
    );
    write_index(&dir, &index)?;
    info.installed_at = Some(installed_at);
    Ok(info)
}

#[tauri::command]
pub async fn pack_list(
    app: AppHandle,
    state: State<'_, PackState>,
) -> Result<Vec<PackInfo>, String> {
    let dir = packs_dir(&app)?;
    let index = {
        let _guard = state.0.lock().map_err(|_| "pack store lock poisoned")?;
        read_index(&dir)
    };
    let mut out = Vec::new();
    for (id, entry) in index {
        if !valid_pack_id(&id) {
            log::warn!("pack index: skipping invalid id");
            continue;
        }
        let path = dir.join(format!("{id}.mixaipack"));
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) => {
                log::warn!("pack {id}: cannot read archive: {e}");
                continue;
            }
        };
        match inspect(&bytes) {
            Ok(mut info) if info.manifest.id == id && info.sha256 == entry.sha256 => {
                info.installed_at = Some(entry.installed_at);
                out.push(info);
            }
            Ok(_) => log::warn!("pack {id}: stored archive does not match the index, skipped"),
            Err(e) => log::warn!("pack {id}: no longer valid, skipped: {e}"),
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn pack_remove(
    app: AppHandle,
    state: State<'_, PackState>,
    id: String,
) -> Result<(), String> {
    if !valid_pack_id(&id) {
        return Err(format!("invalid pack id '{}'", short(&id)));
    }
    let dir = packs_dir(&app)?;
    let _guard = state.0.lock().map_err(|_| "pack store lock poisoned")?;
    let path = dir.join(format!("{id}.mixaipack"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("cannot delete pack: {e}"))?;
    }
    let mut index = read_index(&dir);
    if index.remove(&id).is_some() {
        write_index(&dir, &index)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pack_pick_file(app: AppHandle) -> Result<Option<Vec<u8>>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = futures::channel::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("MixAI pack", &["mixaipack"])
        .pick_file(move |f| {
            let _ = tx.send(f);
        });
    let Some(picked) = rx.await.map_err(|_| "file dialog closed unexpectedly")? else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("unsupported file location: {e}"))?;
    let len = std::fs::metadata(&path)
        .map_err(|e| format!("cannot read file: {e}"))?
        .len();
    if len > MAX_ARCHIVE_BYTES as u64 {
        return Err(format!(
            "pack is too large ({len} bytes, limit {MAX_ARCHIVE_BYTES})"
        ));
    }
    std::fs::read(&path)
        .map(Some)
        .map_err(|e| format!("cannot read file: {e}"))
}

// ---- tests ------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use zip::write::SimpleFileOptions;

    const NO_KEYS: KeyTables<'static> = KeyTables {
        official: &[],
        verified: &[],
    };

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(bytes).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    /// The JS Skin SDK (apps/mixai/sdk) writes its own zips and signatures:
    /// the Rust verifier must accept them byte-for-byte.
    #[test]
    fn sdk_built_packs_verify() {
        let fixture = include_bytes!("../../sdk/fixtures/sample-signed.mixaipack");
        let info = inspect(fixture).expect("sdk fixture verifies");
        assert_eq!(info.manifest.id, "com.example.test.sample");
        assert_eq!(info.trust, PackTrust::Community);

        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web/src/lib/decks-packs/files");
        let mut n = 0;
        for e in std::fs::read_dir(&dir).expect("official packs dir") {
            let p = e.unwrap().path();
            if p.extension().and_then(|x| x.to_str()) != Some("mixaipack") {
                continue;
            }
            let info = inspect(&std::fs::read(&p).unwrap())
                .unwrap_or_else(|err| panic!("{}: {err}", p.display()));
            assert_eq!(info.trust, PackTrust::Official, "{}", p.display());
            n += 1;
        }
        assert!(n >= 4, "expected the official catalogue packs, found {n}");
    }

    const MANIFEST: &str = r#"{"v":1,"id":"com.example.skin.neon","name":"Neon","version":"1.0.0",
        "kind":"skin","author":"Example","description":"Test skin","pro":false,
        "tokens":"tokens.json","layouts":["layouts/main.json"],"preview":"assets/preview.png"}"#;
    const TOKENS: &str = r##"{"mode":"dark","surface":"glass","accent":"violet",
        "colors":{"primary":"oklch(0.72 0.19 300)","border":"#ffffff22"},
        "color":{"$type":"color","deck-a":{"$value":"#00e5ff"}},
        "decks":{"b":"oklch(70% 0.2 30 / 0.9)"},"fontHeading":"Space Grotesk",
        "background":"assets/bg.webp"}"##;
    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";

    fn skin_entries() -> Vec<(&'static str, Vec<u8>)> {
        vec![
            ("manifest.json", MANIFEST.as_bytes().to_vec()),
            ("tokens.json", TOKENS.as_bytes().to_vec()),
            ("layouts/main.json", br#"{"panels":[]}"#.to_vec()),
            ("assets/preview.png", PNG.to_vec()),
            ("assets/bg.webp", b"RIFFfakeWEBP".to_vec()),
        ]
    }

    fn build(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (*n, b.as_slice())).collect();
        zip_of(&refs)
    }

    fn with(name: &'static str, bytes: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
        let mut e = skin_entries();
        e.retain(|(n, _)| *n != name);
        e.push((name, bytes.to_vec()));
        e
    }

    fn err_of(bytes: &[u8]) -> String {
        inspect_with(bytes, &NO_KEYS).expect_err("pack must be rejected")
    }

    #[test]
    fn valid_unsigned_skin_is_accepted() {
        let bytes = build(&skin_entries());
        let info = inspect_with(&bytes, &NO_KEYS).unwrap();
        assert_eq!(info.trust, PackTrust::Unsigned);
        assert_eq!(info.manifest.id, "com.example.skin.neon");
        let t = info.tokens.unwrap();
        let colors = t.colors.unwrap();
        assert_eq!(colors["deck-a"], "#00e5ff");
        assert_eq!(colors["primary"], "oklch(0.72 0.19 300)");
        assert_eq!(t.accent.as_deref(), Some("violet"));
        assert_eq!(info.layouts.unwrap().len(), 1);
        assert!(
            info.preview_data_url
                .unwrap()
                .starts_with("data:image/png;base64,")
        );
        assert!(info.assets.unwrap()["assets/bg.webp"].starts_with("data:image/webp;base64,"));
        assert_eq!(info.sha256.len(), 64);
        // camelCase wire shape for the TS contract.
        let json = serde_json::to_value(inspect_with(&bytes, &NO_KEYS).unwrap()).unwrap();
        assert!(json.get("previewDataUrl").is_some());
        assert!(json["tokens"].get("fontHeading").is_some());
        assert!(json.get("installedAt").is_none());
    }

    #[test]
    fn signed_with_embedded_key_is_community() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let signed = sign_pack(&build(&skin_entries()), &key, "someone-2026").unwrap();
        let info = inspect_with(&signed, &NO_KEYS).unwrap();
        assert_eq!(info.trust, PackTrust::Community);
    }

    #[test]
    fn reserved_identity_needs_an_official_key() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        for (from, to) in [
            ("com.example.skin.neon", "ro.mixai.skin.neon"),
            ("\"author\":\"Example\"", "\"author\":\" mixai \""),
        ] {
            let m = MANIFEST.replacen(from, to, 1);
            let mut entries = skin_entries();
            entries.retain(|(n, _)| *n != "manifest.json");
            entries.push(("manifest.json", m.into_bytes()));
            let err = inspect_with(&build(&entries), &NO_KEYS).unwrap_err();
            assert!(err.contains("reserved"), "{err}");
            let signed = sign_pack(&build(&entries), &key, "someone-2026").unwrap();
            assert!(
                inspect_with(&signed, &NO_KEYS)
                    .unwrap_err()
                    .contains("reserved")
            );
            let pk = key.verifying_key().to_bytes();
            let official = [("test-official", pk)];
            let tables = KeyTables {
                official: &official,
                verified: &[],
            };
            let ok = sign_pack(&build(&entries), &key, "test-official").unwrap();
            assert_eq!(
                inspect_with(&ok, &tables).unwrap().trust,
                PackTrust::Official
            );
        }
    }

    #[test]
    fn signed_by_table_keys_is_official_or_verified() {
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let pk = key.verifying_key().to_bytes();
        let official = [("test-official", pk)];
        let verified = [("test-verified", pk)];
        let tables = KeyTables {
            official: &official,
            verified: &verified,
        };
        let a = sign_pack(&build(&skin_entries()), &key, "test-official").unwrap();
        assert_eq!(
            inspect_with(&a, &tables).unwrap().trust,
            PackTrust::Official
        );
        let b = sign_pack(&build(&skin_entries()), &key, "test-verified").unwrap();
        assert_eq!(
            inspect_with(&b, &tables).unwrap().trust,
            PackTrust::Verified
        );
    }

    #[test]
    fn impersonating_a_table_key_id_is_rejected() {
        // Attacker signs with their own key but claims the official key id.
        let official_key = SigningKey::from_bytes(&[9u8; 32]);
        let official = [("test-official", official_key.verifying_key().to_bytes())];
        let tables = KeyTables {
            official: &official,
            verified: &[],
        };
        let attacker = SigningKey::from_bytes(&[3u8; 32]);
        let forged = sign_pack(&build(&skin_entries()), &attacker, "test-official").unwrap();
        assert!(
            inspect_with(&forged, &tables)
                .unwrap_err()
                .contains("signature is invalid")
        );
    }

    #[test]
    fn builtin_official_key_is_a_valid_point() {
        for (_, k) in OFFICIAL_KEYS {
            assert!(VerifyingKey::from_bytes(k).is_ok());
        }
    }

    #[test]
    fn tampered_entry_after_signing_is_rejected() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let signed = sign_pack(&build(&skin_entries()), &key, "someone-2026").unwrap();
        // Re-pack with one entry changed but the old signature.json kept.
        let mut z = zip::ZipArchive::new(Cursor::new(signed.as_slice())).unwrap();
        let mut entries = Vec::new();
        for i in 0..z.len() {
            let mut f = z.by_index(i).unwrap();
            let name: &'static str = Box::leak(f.name().unwrap().into_owned().into_boxed_str());
            let mut b = Vec::new();
            f.read_to_end(&mut b).unwrap();
            if name == "tokens.json" {
                b = TOKENS.replace("#00e5ff", "#ff0000").into_bytes();
            }
            entries.push((name, b));
        }
        let err = err_of(&build(&entries));
        assert!(err.contains("signature is invalid"), "{err}");
    }

    #[test]
    fn path_traversal_is_rejected() {
        let mut e = skin_entries();
        e.push(("../evil.json", b"{}".to_vec()));
        assert!(err_of(&build(&e)).contains("invalid entry name"));
        let mut e = skin_entries();
        e.push(("/abs.json", b"{}".to_vec()));
        assert!(err_of(&build(&e)).contains("invalid entry name"));
        let mut e = skin_entries();
        e.push(("a\\b.json", b"{}".to_vec()));
        assert!(err_of(&build(&e)).contains("invalid entry name"));
    }

    #[test]
    fn svg_is_rejected() {
        let mut e = skin_entries();
        e.push(("assets/logo.svg", b"<svg onload=alert(1)/>".to_vec()));
        assert!(err_of(&build(&e)).contains("file type not allowed"));
    }

    #[test]
    fn zip_bomb_ratio_is_rejected() {
        let mut e = skin_entries();
        e.push(("assets/zeros.json", vec![b' '; 2 * 1024 * 1024]));
        let err = err_of(&build(&e));
        assert!(err.contains("zip bomb"), "{err}");
    }

    #[test]
    fn url_colour_is_rejected() {
        let t = TOKENS.replace("#ffffff22", "url(https://x/y.png)");
        let err = err_of(&build(&with("tokens.json", t.as_bytes())));
        assert!(err.contains("must be #rrggbb"), "{err}");
        for bad in [
            "var(--x)",
            "oklch(2 0.1 30)",
            "oklch(0.5 0.1 30 / 2)",
            "#fff",
            "red",
            "oklch(0.5 0.1 calc(1))",
        ] {
            assert!(!valid_color(bad), "{bad}");
        }
        for good in [
            "#a1b2c3",
            "#a1b2c3d4",
            "oklch(0.5 0.1 30)",
            "oklch(50% 0.1 30 / 50%)",
        ] {
            assert!(valid_color(good), "{good}");
        }
    }

    #[test]
    fn unknown_colour_key_is_rejected() {
        let t = TOKENS.replace("\"border\"", "\"--evil\"");
        let err = err_of(&build(&with("tokens.json", t.as_bytes())));
        assert!(err.contains("not allowed"), "{err}");
    }

    #[test]
    fn missing_manifest_is_rejected() {
        let mut e = skin_entries();
        e.retain(|(n, _)| *n != "manifest.json");
        assert!(err_of(&build(&e)).contains("manifest.json is missing"));
    }

    #[test]
    fn too_many_entries_is_rejected() {
        let mut e = skin_entries();
        for i in 0..MAX_ENTRIES {
            let name: &'static str = Box::leak(format!("presets/p{i}.json").into_boxed_str());
            e.push((name, b"{}".to_vec()));
        }
        assert!(err_of(&build(&e)).contains("too many entries"));
    }

    #[test]
    fn manifest_rules_are_enforced() {
        let cases = [
            ("\"v\":1", "\"v\":2"),
            ("com.example.skin.neon", "Ro.Mixai"),
            ("com.example.skin.neon", "single"),
            ("\"1.0.0\"", "\"1.0\""),
            ("\"kind\":\"skin\"", "\"kind\":\"script\""),
            ("\"tokens.json\"", "\"missing.json\""),
            ("\"pro\":false", "\"pro\":false,\"script\":\"x.js\""),
        ];
        for (from, to) in cases {
            assert!(
                MANIFEST.contains(from),
                "case '{from}' must match the test manifest"
            );
            let m = MANIFEST.replacen(from, to, 1);
            assert!(
                inspect_with(&build(&with("manifest.json", m.as_bytes())), &NO_KEYS).is_err(),
                "{to} must be rejected"
            );
        }
    }

    #[test]
    fn background_must_be_an_image_in_the_pack() {
        let t = TOKENS.replace("assets/bg.webp", "assets/nope.webp");
        assert!(err_of(&build(&with("tokens.json", t.as_bytes()))).contains("missing"));
    }

    #[test]
    fn pack_ids_follow_the_pattern() {
        assert!(valid_pack_id("ro.mixai.skin.neon"));
        assert!(valid_pack_id("me.dark-mode"));
        for bad in [
            "ro",
            "ro..x",
            "Ro.x",
            "ro.x/../y",
            "-ro.x",
            "a.b.c.d.e.f.g.h",
        ] {
            assert!(!valid_pack_id(bad), "{bad}");
        }
    }
}
