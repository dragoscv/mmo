//! `.mixaipack` packs: Tauri commands over the shared `decks-packs` crate (validation, Ed25519
//! verification, storage). Format: docs/decks/packs.md. TS contract: src/bridge/packs.ts (the serde
//! camelCase of `decks_packs::PackInfo` must match it exactly).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use decks_packs::{
    MAX_ARCHIVE_BYTES, PACK_EXTENSION, PackExportRequest, PackInfo, PackStore, build_skin_pack,
    export_file_name, inspect,
};
use tauri::{AppHandle, Manager, State};

/// Serialises store writes across commands.
#[derive(Default)]
pub struct PackState(Mutex<()>);

fn packs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("packs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn store(app: &AppHandle) -> Result<PackStore, String> {
    packs_dir(app).map(PackStore::new)
}

// ---- commands -------------------------------------------------------------------------

/// Pack bytes travel as a raw IPC body (`invoke(cmd, Uint8Array)`), not as a JSON number array:
/// a 25 MB pack as JSON is ~100 MB of text and seconds of parsing on both sides. When the custom
/// IPC protocol is unavailable Tauri falls back to postMessage, which serialises a raw body as a
/// JSON byte array; that form is still accepted so installs keep working on the fallback path.
fn raw_body(body: &tauri::ipc::InvokeBody) -> Result<std::borrow::Cow<'_, [u8]>, String> {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(std::borrow::Cow::Borrowed(bytes)),
        tauri::ipc::InvokeBody::Json(v) => serde_json::from_value::<Vec<u8>>(v.clone())
            .map(std::borrow::Cow::Owned)
            .map_err(|_| "pack bytes must be sent as a binary body (Uint8Array)".to_string()),
    }
}

#[tauri::command]
pub async fn pack_inspect(request: tauri::ipc::Request<'_>) -> Result<PackInfo, String> {
    inspect(&raw_body(request.body())?)
}

#[tauri::command]
pub async fn pack_install(
    app: AppHandle,
    state: State<'_, PackState>,
    request: tauri::ipc::Request<'_>,
) -> Result<PackInfo, String> {
    let bytes = raw_body(request.body())?;
    let store = store(&app)?;
    let _guard = state.0.lock().map_err(|_| "pack store lock poisoned")?;
    store.install(&bytes)
}

#[tauri::command]
pub async fn pack_list(
    app: AppHandle,
    state: State<'_, PackState>,
) -> Result<Vec<PackInfo>, String> {
    let store = store(&app)?;
    let (packs, skipped) = {
        let _guard = state.0.lock().map_err(|_| "pack store lock poisoned")?;
        store.list_detailed()
    };
    for s in skipped {
        log::warn!("pack {}: skipped: {}", s.id, s.reason);
    }
    Ok(packs)
}

#[tauri::command]
pub async fn pack_remove(
    app: AppHandle,
    state: State<'_, PackState>,
    id: String,
) -> Result<(), String> {
    let store = store(&app)?;
    let _guard = state.0.lock().map_err(|_| "pack store lock poisoned")?;
    store.remove(&id)
}

/// Returns the file as a raw ArrayBuffer; an empty buffer means the dialog was cancelled
/// (a valid pack is never empty).
#[tauri::command]
pub async fn pack_pick_file(app: AppHandle) -> Result<tauri::ipc::Response, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = futures::channel::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("MixAI pack", &["mixaipack"])
        .pick_file(move |f| {
            let _ = tx.send(f);
        });
    let Some(picked) = rx.await.map_err(|_| "file dialog closed unexpectedly")? else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
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
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("cannot read file: {e}"))
}

// ---- skin editor export -----------------------------------------------------------------

/// Bytes of the unsigned skin `.mixaipack` for a skin-editor request: `manifest.json` (`v: 2`,
/// `kind: "skin"`, `pro: false`, `tokens: "tokens.json"`) + `tokens.json`, no signature (trust
/// "unsigned"). The shared builder runs the install-time validation (`decks_packs::inspect`)
/// on the result, so id, name, version and every token (style block included) are checked with
/// the same rules as `pack_install`. Passing them is not a promise that it installs: the store
/// also compares trust (`PackStore::install`), so this unsigned build is refused while a signed
/// pack with the same id is installed ("a more trusted pack with the id … is already installed").
pub fn skin_pack_bytes(req: &PackExportRequest) -> Result<Vec<u8>, String> {
    build_skin_pack(req)
}

/// The path to save an exported pack at: what the user picked, with `.mixaipack` added unless
/// the name already ends with it. Pack ids contain dots (`user.skin.my-booth`), so "has an
/// extension" is not the test: without this, a name typed without the suffix would be saved as
/// a file the "Install from file" dialog (which lists only `.mixaipack`) never shows.
///
/// The save dialog asked about replacing the name the user picked, not the name with the suffix
/// added: when that other file exists the export is refused instead of silently replacing it.
fn export_path(picked: PathBuf) -> Result<PathBuf, String> {
    let is_pack = picked
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case(PACK_EXTENSION));
    if is_pack {
        return Ok(picked);
    }
    let mut name = picked.into_os_string();
    name.push(".");
    name.push(PACK_EXTENSION);
    let target = PathBuf::from(name);
    if target.exists() {
        return Err(format!(
            "{} already exists; pick that file in the dialog to replace it",
            target.display()
        ));
    }
    Ok(target)
}

/// Write an exported pack where the save dialog pointed. Returns the path as shown to the user.
fn save_pack(path: &Path, bytes: &[u8]) -> Result<String, String> {
    std::fs::write(path, bytes).map_err(|e| format!("cannot save {}: {e}", path.display()))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Build the skin pack in memory and return it as a raw ArrayBuffer (no dialog), so the skin
/// editor can install what it just made through `pack_install`.
#[tauri::command]
pub async fn pack_build(req: PackExportRequest) -> Result<tauri::ipc::Response, String> {
    skin_pack_bytes(&req).map(tauri::ipc::Response::new)
}

/// Build the skin pack and save it where the user picks (default name `<id>.mixaipack`).
/// `Ok(Some(path))` when saved, `Ok(None)` when the dialog was cancelled. An invalid request is
/// refused before any dialog opens.
#[tauri::command]
pub async fn pack_export(app: AppHandle, req: PackExportRequest) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let bytes = skin_pack_bytes(&req)?;
    let (tx, rx) = futures::channel::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("MixAI pack", &[PACK_EXTENSION])
        .set_file_name(export_file_name(&req.id))
        .save_file(move |f| {
            let _ = tx.send(f);
        });
    let Some(picked) = rx.await.map_err(|_| "file dialog closed unexpectedly")? else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| format!("unsupported file location: {e}"))?;
    save_pack(&export_path(path)?, &bytes).map(Some)
}

// ---- tests ------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use decks_packs::PackTrust;
    use serde_json::json;

    /// What the skin editor sends over IPC (`PackExportRequest` in src/bridge/packs.ts).
    fn export_request(tokens: serde_json::Value) -> PackExportRequest {
        serde_json::from_value(json!({
            "id": "user.skin.my-booth",
            "name": "My booth",
            "author": "Someone",
            "description": "Made in the skin editor",
            "version": "1.0.0",
            "tokens": tokens,
        }))
        .expect("request shape of src/bridge/packs.ts")
    }

    fn styled_tokens() -> serde_json::Value {
        json!({
            "mode": "dark",
            "accent": "#00d37f",
            "colors": { "background": "#050607", "primary": "oklch(0.8 0.2 150)" },
            "decks": { "a": "#00e5ff", "b": "#ff2bd6" },
            "style": {
                "look": "signature",
                "platter": false,
                "layout": "pro",
                "waves": "stacked",
                "colors": { "well": "#0b0d0f", "on": "#00d37f", "cue1": "#ff0000" },
                "sizes": { "panelGap": 4.0, "controlHeight": 28.0, "wavePlayedAlpha": 0.5 }
            }
        })
    }

    #[test]
    fn pack_build_round_trips_through_inspect() {
        let bytes = skin_pack_bytes(&export_request(styled_tokens())).unwrap();
        let info = inspect(&bytes).expect("a built pack passes the install validation");
        assert_eq!(info.trust, PackTrust::Unsigned);
        assert_eq!(info.manifest.v, 2);
        assert_eq!(info.manifest.id, "user.skin.my-booth");
        assert_eq!(info.manifest.kind, decks_packs::PackKind::Skin);
        assert!(!info.manifest.pro);
        assert_eq!(info.manifest.tokens.as_deref(), Some("tokens.json"));
        // The tokens the UI reads back are the ones it sent, style block included (camelCase).
        assert_eq!(serde_json::to_value(&info.tokens).unwrap(), styled_tokens());
        // No signature file, exactly two entries.
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes.as_slice())).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().unwrap().into_owned())
            .collect();
        assert_eq!(names, ["manifest.json", "tokens.json"]);
    }

    #[test]
    fn pack_build_refuses_what_install_would_refuse() {
        let cases = [
            (json!({ "mode": "sepia" }), "tokens.mode 'sepia'"),
            (
                json!({ "colors": { "primary": "url(https://x/y.png)" } }),
                "must be #rrggbb",
            ),
            (
                json!({ "style": { "sizes": { "panelGap": 99 } } }),
                "style.sizes.panelGap must be a number in 0..16",
            ),
            (
                json!({ "style": { "layout": "../evil" } }),
                "style.layout must be a layout id",
            ),
            (
                json!({ "style": { "css": "body{}" } }),
                "unknown style key 'css'",
            ),
        ];
        for (tokens, want) in cases {
            let err = skin_pack_bytes(&export_request(tokens.clone())).unwrap_err();
            assert!(err.contains(want), "{tokens}: {err}");
        }
        let mut reserved = export_request(json!({}));
        reserved.id = "ro.mixai.skin.fake".into();
        assert!(skin_pack_bytes(&reserved).unwrap_err().contains("reserved"));
        let mut bad_id = export_request(json!({}));
        bad_id.id = "my skin".into();
        assert!(
            skin_pack_bytes(&bad_id)
                .unwrap_err()
                .contains("manifest.id")
        );
        let mut bad_version = export_request(json!({}));
        bad_version.version = "v1".into();
        assert!(
            skin_pack_bytes(&bad_version)
                .unwrap_err()
                .contains("MAJOR.MINOR.PATCH")
        );
    }

    #[test]
    fn pack_export_saves_an_installable_file() {
        let req = export_request(styled_tokens());
        let name = export_file_name(&req.id);
        assert_eq!(name, "user.skin.my-booth.mixaipack");
        let dir = std::env::temp_dir().join(format!("mixai-pack-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(&name);
        let bytes = skin_pack_bytes(&req).unwrap();
        let shown = save_pack(&path, &bytes).unwrap();
        assert_eq!(shown, path.to_string_lossy());
        // The saved file installs into a store and keeps its style block.
        let store = PackStore::new(dir.join("packs"));
        let info = store.install(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(info.manifest.id, req.id);
        let style = info.tokens.unwrap().style.unwrap();
        assert_eq!(style.layout.as_deref(), Some("pro"));
        // A location that cannot be written is a readable error, not a panic.
        let err = save_pack(&dir.join("missing-dir").join(&name), &bytes).unwrap_err();
        assert!(err.starts_with("cannot save "), "{err}");
        // The saved file always ends with `.mixaipack`; a name that already does is kept as is.
        let skins = PathBuf::from("skins");
        for (typed, saved) in [
            ("my-booth", "my-booth.mixaipack"),
            ("user.skin.my-booth", "user.skin.my-booth.mixaipack"),
            ("my-booth.zip", "my-booth.zip.mixaipack"),
            (
                "user.skin.my-booth.mixaipack",
                "user.skin.my-booth.mixaipack",
            ),
            ("MY-BOOTH.MIXAIPACK", "MY-BOOTH.MIXAIPACK"),
        ] {
            assert_eq!(
                export_path(skins.join(typed)),
                Ok(skins.join(saved)),
                "{typed}"
            );
        }
        // Adding the suffix never replaces a file the dialog did not ask about: `path` exists
        // (saved above), and the name typed without the suffix would land on it.
        let err = export_path(dir.join("user.skin.my-booth")).unwrap_err();
        assert!(err.ends_with("already exists; pick that file in the dialog to replace it"));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "the file is untouched"
        );
        // Picking the existing file itself is the user's confirmed choice.
        assert_eq!(export_path(path.clone()), Ok(path.clone()));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The JS Skin SDK (apps/mixai/sdk) writes its own zips and signatures:
    /// the Rust verifier must accept them byte-for-byte.
    #[test]
    fn sdk_built_packs_verify() {
        let fixture = include_bytes!("../../sdk/fixtures/sample-signed.mixaipack");
        let info = inspect(fixture).expect("sdk fixture verifies");
        assert_eq!(info.manifest.id, "com.example.test.sample");
        assert_eq!(info.trust, PackTrust::Community);

        // Manifest v2 written and signed by the SDK: the style block reads back in full.
        let styled = include_bytes!("../../sdk/fixtures/sample-style.mixaipack");
        let info = inspect(styled).expect("sdk v2 fixture verifies");
        assert_eq!(info.manifest.id, "com.example.test.style");
        assert_eq!(info.manifest.v, 2);
        assert_eq!(info.trust, PackTrust::Community);
        let style = info.tokens.unwrap().style.expect("style block");
        assert_eq!(style.look.as_deref(), Some("classic"));
        assert_eq!(style.platter, Some(true));
        assert_eq!(style.layout.as_deref(), Some("pro-vertical"));
        assert_eq!(style.waves.as_deref(), Some("overlay"));
        let colors = style.colors.unwrap();
        let keys: Vec<&str> = colors.keys().map(String::as_str).collect();
        let mut want = decks_packs::STYLE_COLOR_KEYS.to_vec();
        want.sort_unstable();
        assert_eq!(
            keys, want,
            "every style colour key of the SDK is known here"
        );
        let sizes = style.sizes.unwrap();
        assert_eq!(sizes.len(), decks_packs::STYLE_SIZES.len());
        assert_eq!(sizes["wavePlayedAlpha"], 0.45);

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

    #[test]
    fn pack_bytes_only_arrive_as_a_raw_body() {
        let raw = tauri::ipc::InvokeBody::Raw(vec![1, 2, 3]);
        assert_eq!(&*raw_body(&raw).unwrap(), &[1, 2, 3]);
        // postMessage fallback: the raw body arrives as a JSON byte array.
        let fallback = tauri::ipc::InvokeBody::Json(serde_json::json!([1, 2, 3]));
        assert_eq!(&*raw_body(&fallback).unwrap(), &[1, 2, 3]);
        // Anything else (old `{ bytes }` args object, out-of-range numbers) is refused.
        let args = tauri::ipc::InvokeBody::Json(serde_json::json!({ "bytes": [1, 2, 3] }));
        assert!(raw_body(&args).unwrap_err().contains("binary body"));
        let big = tauri::ipc::InvokeBody::Json(serde_json::json!([256]));
        assert!(raw_body(&big).is_err());
    }
}
