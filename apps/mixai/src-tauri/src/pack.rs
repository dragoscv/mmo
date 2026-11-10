//! `.mixaipack` packs: Tauri commands over the shared `decks-packs` crate (validation, Ed25519
//! verification, storage). Format: docs/decks/packs.md. TS contract: src/bridge/packs.ts (the serde
//! camelCase of `decks_packs::PackInfo` must match it exactly).

use std::path::PathBuf;
use std::sync::Mutex;

use decks_packs::{MAX_ARCHIVE_BYTES, PackInfo, PackStore, inspect};
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

// ---- tests ------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use decks_packs::PackTrust;

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
