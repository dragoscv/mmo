//! Persisted desktop settings (`<app config dir>/settings.json`): audio device config + last preset.

use crate::engine::EngineConfig;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const FILE: &str = "settings.json";
const MAX_BYTES: u64 = 256 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Audio setup from the wizard; `None` until the first successful start.
    pub device: Option<EngineConfig>,
    pub last_preset: Option<String>,
    /// "Allow phones on the network" (engine started with `--lan`).
    pub lan: bool,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(FILE))
}

pub fn read(app: &AppHandle) -> Settings {
    let Ok(p) = path(app) else {
        return Settings::default();
    };
    match fs::metadata(&p) {
        Ok(m) if m.len() <= MAX_BYTES => fs::read_to_string(&p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default(),
        _ => Settings::default(),
    }
}

pub fn write(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let p = path(app)?;
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Settings {
    read(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    if let Some(d) = &settings.device {
        d.validate()?;
    }
    if settings
        .last_preset
        .as_deref()
        .is_some_and(|p| p.len() > 200)
    {
        return Err("preset name too long".into());
    }
    write(&app, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_with_defaults() {
        let s: Settings = serde_json::from_str("{\"lastPreset\":\"Natural Vocal\"}").unwrap();
        assert_eq!(s.last_preset.as_deref(), Some("Natural Vocal"));
        assert!(s.device.is_none() && !s.lan);
        let back: Settings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }
}
