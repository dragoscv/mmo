//! MMO Companion bridge.
//!
//! The companion (the Electron/Node app in `server/`) owns the user's music
//! library in a local SQLite DB and exposes it over HTTP on
//! `http://127.0.0.1:17899`. We proxy those requests through Rust rather than
//! `fetch` from the webview for two reasons:
//!
//!   1. The companion's CORS allowlist accepts loopback + the muzicai.ro web
//!      origins, NOT the Tauri webview origin (`tauri.localhost` /
//!      `https://tauri.localhost`). A direct browser fetch would be blocked.
//!   2. Keeping the device token in the Rust process avoids exposing it to any
//!      web content that might run in the webview.
//!
//! Auth: `/library/*` requires `X-Device-Token` (the companion device token)
//! plus `X-User-Id` (the signed-in muzicai.ro user id). Both are configured by
//! the UI and held here. Since the companion runs on the same machine, the
//! track rows carry a local `filepath` that the audio core decodes directly —
//! no streaming endpoint is needed for local playback.

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// UI-configurable connection settings, managed by Tauri.
#[derive(Default)]
pub struct CompanionState(pub Mutex<CompanionConfig>);

#[derive(Clone, Default)]
pub struct CompanionConfig {
    /// Base URL, e.g. `http://127.0.0.1:17899`. Empty = unconfigured.
    pub base_url: String,
    /// Companion device token (`X-Device-Token`).
    pub device_token: String,
    /// muzicai.ro user id (`X-User-Id`).
    pub user_id: String,
}

impl CompanionConfig {
    fn base(&self) -> &str {
        if self.base_url.is_empty() {
            "http://127.0.0.1:17899"
        } else {
            self.base_url.trim_end_matches('/')
        }
    }
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

// ─── Health / status ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct CompanionStatus {
    pub online: bool,
    pub version: Option<String>,
    pub hostname: Option<String>,
    pub authed: bool,
}

#[derive(Deserialize)]
struct HealthResp {
    version: Option<String>,
    hostname: Option<String>,
}

/// Probe the companion `/health` (no auth). Reports whether the device
/// token + user id are also configured so the UI can guide the user.
#[tauri::command]
pub async fn companion_status(
    state: tauri::State<'_, CompanionState>,
) -> Result<CompanionStatus, String> {
    let (base, authed) = {
        let cfg = state.0.lock().unwrap();
        (
            cfg.base().to_string(),
            !cfg.device_token.is_empty() && !cfg.user_id.is_empty(),
        )
    };
    let client = http()?;
    let url = format!("{base}/health");
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body: HealthResp = resp.json().await.unwrap_or(HealthResp {
                version: None,
                hostname: None,
            });
            Ok(CompanionStatus {
                online: true,
                version: body.version,
                hostname: body.hostname,
                authed,
            })
        }
        _ => Ok(CompanionStatus {
            online: false,
            version: None,
            hostname: None,
            authed,
        }),
    }
}

/// Update the companion connection settings from the UI.
#[tauri::command]
pub fn companion_configure(
    base_url: Option<String>,
    device_token: Option<String>,
    user_id: Option<String>,
    state: tauri::State<'_, CompanionState>,
) -> Result<(), String> {
    let mut cfg = state.0.lock().unwrap();
    if let Some(v) = base_url {
        cfg.base_url = v.trim().to_string();
    }
    if let Some(v) = device_token {
        cfg.device_token = v.trim().to_string();
    }
    if let Some(v) = user_id {
        cfg.user_id = v.trim().to_string();
    }
    Ok(())
}

// ─── Library tracks ─────────────────────────────────────────────────────────

/// A track row as the UI needs it. Mirrors the companion's `tracks` table but
/// only the fields MIXAI uses. `filepath` is the local path the audio core
/// decodes directly.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryTrack {
    pub id: i64,
    pub filepath: String,
    pub filename: String,
    pub artist: Option<String>,
    pub title: Option<String>,
    pub bpm: Option<f64>,
    pub key_camelot: Option<String>,
    pub duration: Option<i64>,
    pub genre: Option<String>,
    pub is_favorite: Option<bool>,
    pub rating: Option<i64>,
    /// Stem separation status: "queued" | "processing" | "ready" | "error" | null.
    pub stems_status: Option<String>,
}

/// The companion returns rows with camelCase keys (Drizzle column names map to
/// snake_case in SQLite but Drizzle's `select()` returns the JS property names,
/// which are camelCase). Deserialize defensively with serde aliases.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTrack {
    id: i64,
    filepath: String,
    filename: String,
    artist: Option<String>,
    title: Option<String>,
    bpm: Option<f64>,
    #[serde(alias = "key_camelot")]
    key_camelot: Option<String>,
    duration: Option<i64>,
    genre: Option<String>,
    #[serde(alias = "is_favorite")]
    is_favorite: Option<bool>,
    rating: Option<i64>,
    #[serde(alias = "stems_status")]
    stems_status: Option<String>,
}

#[derive(Deserialize)]
struct TracksResp {
    tracks: Vec<RawTrack>,
    total: i64,
    page: i64,
    #[serde(rename = "totalPages")]
    total_pages: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryPage {
    pub tracks: Vec<LibraryTrack>,
    pub total: i64,
    pub page: i64,
    pub total_pages: i64,
}

/// List tracks from the companion library. `search`/`page` are optional.
#[tauri::command]
pub async fn companion_tracks(
    search: Option<String>,
    page: Option<i64>,
    sort: Option<String>,
    order: Option<String>,
    state: tauri::State<'_, CompanionState>,
) -> Result<LibraryPage, String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured (missing device token or user id)".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };

    let client = http()?;
    let mut req = client
        .get(format!("{base}/library/tracks"))
        .header("X-Device-Token", token)
        .header("X-User-Id", user)
        .query(&[
            ("page", page.unwrap_or(1).to_string()),
            ("pageSize", "100".to_string()),
            ("sort", sort.unwrap_or_else(|| "addedAt".to_string())),
            ("order", order.unwrap_or_else(|| "desc".to_string())),
        ]);
    if let Some(s) = search.filter(|s| !s.trim().is_empty()) {
        req = req.query(&[("search", s)]);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("companion {status}: {body}"));
    }
    let parsed: TracksResp = resp.json().await.map_err(|e| e.to_string())?;

    Ok(LibraryPage {
        tracks: parsed
            .tracks
            .into_iter()
            .map(|t| LibraryTrack {
                id: t.id,
                filepath: t.filepath,
                filename: t.filename,
                artist: t.artist,
                title: t.title,
                bpm: t.bpm,
                key_camelot: t.key_camelot,
                duration: t.duration,
                genre: t.genre,
                is_favorite: t.is_favorite,
                rating: t.rating,
                stems_status: t.stems_status,
            })
            .collect(),
        total: parsed.total,
        page: parsed.page,
        total_pages: parsed.total_pages,
    })
}

/// Toggle a track's favorite flag on the companion.
#[tauri::command]
pub async fn companion_toggle_favorite(
    id: i64,
    state: tauri::State<'_, CompanionState>,
) -> Result<bool, String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };
    let client = http()?;
    let resp = client
        .post(format!("{base}/library/tracks/{id}/favorite"))
        .header("X-Device-Token", token)
        .header("X-User-Id", user)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("companion {}", resp.status()));
    }
    #[derive(Deserialize)]
    struct FavResp {
        #[serde(rename = "isFavorite")]
        is_favorite: bool,
    }
    let body: FavResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body.is_favorite)
}

// ─── Stems ──────────────────────────────────────────────────────────────────

/// Resolved stem paths for a track. Absolute local WAV paths (the companion
/// runs on the same machine), or null when not yet separated.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrackStems {
    pub status: Option<String>,
    pub model: Option<String>,
    pub vocals: Option<String>,
    pub drums: Option<String>,
    pub bass: Option<String>,
    pub melody: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawTrackDetail {
    filepath: Option<String>,
    #[serde(alias = "stems_status")]
    stems_status: Option<String>,
    #[serde(alias = "stems_model")]
    stems_model: Option<String>,
    #[serde(alias = "stems_vocals_path")]
    stems_vocals_path: Option<String>,
    #[serde(alias = "stems_drums_path")]
    stems_drums_path: Option<String>,
    #[serde(alias = "stems_bass_path")]
    stems_bass_path: Option<String>,
    #[serde(alias = "stems_melody_path")]
    stems_melody_path: Option<String>,
}

/// Fetch a single track's stem paths + status from the companion.
#[tauri::command]
pub async fn companion_track_stems(
    id: i64,
    state: tauri::State<'_, CompanionState>,
) -> Result<TrackStems, String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };
    let client = http()?;
    let resp = client
        .get(format!("{base}/library/tracks/{id}"))
        .header("X-Device-Token", token)
        .header("X-User-Id", user)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("companion {status}: {body}"));
    }
    let t: RawTrackDetail = resp.json().await.map_err(|e| e.to_string())?;
    Ok(TrackStems {
        status: t.stems_status,
        model: t.stems_model,
        vocals: t.stems_vocals_path,
        drums: t.stems_drums_path,
        bass: t.stems_bass_path,
        melody: t.stems_melody_path,
    })
}

/// Request stem separation for a track. Returns the analysis job id to poll.
#[tauri::command]
pub async fn companion_request_stems(
    id: i64,
    model: Option<String>,
    state: tauri::State<'_, CompanionState>,
) -> Result<Option<String>, String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };
    let client = http()?;
    let mut options = serde_json::json!({ "stems": true });
    if let Some(m) = model {
        options["stemsModel"] = serde_json::Value::String(m);
    }
    let resp = client
        .post(format!("{base}/analyze"))
        .header("X-Device-Token", token)
        .header("X-User-Id", user)
        .json(&serde_json::json!({ "trackIds": [id], "options": options }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("companion {status}: {body}"));
    }
    #[derive(Deserialize)]
    struct Job {
        id: String,
    }
    #[derive(Deserialize)]
    struct AnalyzeResp {
        jobs: Vec<Job>,
    }
    let body: AnalyzeResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body.jobs.into_iter().next().map(|j| j.id))
}

/// Poll an analysis job. Returns (state, progress 0..1, message, stems-ready).
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StemJob {
    pub state: String,
    pub progress: f64,
    pub message: Option<String>,
    pub stems: Option<TrackStems>,
}

#[tauri::command]
pub async fn companion_stem_job(
    job_id: String,
    state: tauri::State<'_, CompanionState>,
) -> Result<StemJob, String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };
    let client = http()?;
    let resp = client
        .get(format!("{base}/analyze/job/{job_id}"))
        .header("X-Device-Token", token)
        .header("X-User-Id", user)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("companion {status}: {body}"));
    }
    #[derive(Deserialize)]
    struct StemsData {
        vocals: Option<String>,
        drums: Option<String>,
        bass: Option<String>,
        other: Option<String>,
    }
    #[derive(Deserialize)]
    struct JobData {
        stems: Option<StemsData>,
    }
    #[derive(Deserialize)]
    struct JobInner {
        state: String,
        #[serde(default)]
        progress: f64,
        message: Option<String>,
        data: Option<JobData>,
    }
    #[derive(Deserialize)]
    struct JobResp {
        job: JobInner,
    }
    let body: JobResp = resp.json().await.map_err(|e| e.to_string())?;
    let j = body.job;
    let stems = j.data.and_then(|d| d.stems).map(|s| TrackStems {
        status: Some("ready".into()),
        model: None,
        vocals: s.vocals,
        drums: s.drums,
        bass: s.bass,
        // The companion's 4th stem "other" maps to MIXAI's "melody" slot.
        melody: s.other,
    });
    Ok(StemJob {
        state: j.state,
        progress: j.progress,
        message: j.message,
        stems,
    })
}

// ─── Profile sync ─────────────────────────────────────────────────────────

/// Fetch the stored MIXAI profile blob for the signed-in user, or `None` if
/// nothing has been saved yet. The blob is opaque JSON (the UI owns the
/// schema); we return it as a string so it round-trips untouched.
#[tauri::command]
pub async fn companion_get_profile(
    state: tauri::State<'_, CompanionState>,
) -> Result<Option<String>, String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };
    let client = http()?;
    let resp = client
        .get(format!("{base}/mixai-profile"))
        .header("X-Device-Token", token)
        .header("X-User-Id", user)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("companion {status}: {body}"));
    }
    #[derive(Deserialize)]
    struct ProfileResp {
        profile: Option<serde_json::Value>,
    }
    let body: ProfileResp = resp.json().await.map_err(|e| e.to_string())?;
    Ok(body.profile.map(|v| v.to_string()))
}

/// Store (replace) the MIXAI profile blob for the signed-in user. `profile` is
/// the JSON string produced by the UI's `exportProfile`; we parse it once to
/// reject garbage before forwarding it as `{ profile: <object> }`.
#[tauri::command]
pub async fn companion_put_profile(
    profile: String,
    state: tauri::State<'_, CompanionState>,
) -> Result<(), String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&profile).map_err(|e| format!("invalid profile JSON: {e}"))?;
    let client = http()?;
    let resp = client
        .put(format!("{base}/mixai-profile"))
        .header("X-Device-Token", token)
        .header("X-User-Id", user)
        .json(&serde_json::json!({ "profile": parsed }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("companion {status}: {body}"));
    }
    Ok(())
}

// ─── Streaming (remote audio) ────────────────────────────────────────────────

/// Encoded audio fetched from a remote companion, ready to decode in-memory.
pub struct RemoteAudio {
    pub bytes: Vec<u8>,
    /// Container hint (file extension, lowercase, no dot) when known.
    pub ext: Option<String>,
}

/// Fetch a track's encoded bytes from the companion's range-aware
/// `GET /audio/<filepath>` route. Used when the companion runs on another
/// machine (LAN / tunnel), so the file isn't on the local disk and must be
/// streamed and decoded in memory. Returns the whole encoded file (decks need
/// the full buffer for waveform/beatgrid/instant seek).
///
/// Not a `#[tauri::command]` — called from `lib.rs` so the megabytes never
/// cross the JS IPC boundary; only the small decoded handle returns to the UI.
pub async fn fetch_track_audio(
    state: &tauri::State<'_, CompanionState>,
    id: i64,
) -> Result<RemoteAudio, String> {
    let (base, token, user) = {
        let cfg = state.0.lock().unwrap();
        if cfg.device_token.is_empty() || cfg.user_id.is_empty() {
            return Err("Companion not configured".into());
        }
        (
            cfg.base().to_string(),
            cfg.device_token.clone(),
            cfg.user_id.clone(),
        )
    };

    // First resolve the track's filepath (the /audio route is keyed by path).
    let meta_client = http()?;
    let detail: RawTrackDetail = meta_client
        .get(format!("{base}/library/tracks/{id}"))
        .header("X-Device-Token", &token)
        .header("X-User-Id", &user)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let filepath = detail
        .filepath
        .ok_or_else(|| "track has no filepath".to_string())?;
    let ext = std::path::Path::new(&filepath)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    // Larger timeout for the actual transfer (whole file over a tunnel).
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let encoded = urlencoding_encode(&filepath);
    let resp = client
        .get(format!("{base}/audio/{encoded}"))
        .header("X-Device-Token", &token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("companion {status}: {body}"));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.is_empty() {
        return Err("companion returned empty audio".into());
    }
    Ok(RemoteAudio { bytes, ext })
}

/// Minimal percent-encoding for a filesystem path placed in a URL path segment.
/// The companion's `/audio/*` route `decodeURIComponent`s the tail, so we mirror
/// `encodeURIComponent` semantics (keep unreserved + a few path chars).
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
