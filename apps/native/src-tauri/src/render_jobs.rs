//! Native render-job queue persisted in SQLite under the Tauri
//! `app_data_dir`. Mirrors the companion's in-memory `RenderHost`
//! (server/src/render/host.ts) so the desktop app can keep a durable
//! history of project renders even when running fully offline.
//!
//! The web app calls `enqueue_render` over the Tauri IPC when it wants
//! the native shell to remember a bounce. Today the rendering itself
//! still happens in the browser (`DAWEngine.exportProject`) — the
//! native shell only owns the queue + on-disk artifacts. When the
//! native engine grows an offline-render mode it will pick jobs in
//! `queued` state up from this table.
//!
//! On launch, `resume_pending` flips any rows that were left in
//! `queued`/`uploading` (typically because the app was killed mid-job)
//! to `error` with a clear message so the UI never shows a stuck job.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderJob {
    pub id: String,
    pub project_external_id: String,
    pub format: String, // "wav" | "mp3"
    pub mode: String,   // "upload" | "native"
    pub stage: String,  // "queued" | "uploading" | "ready" | "error"
    pub bytes: i64,
    pub output_path: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

pub struct RenderJobsState {
    conn: Mutex<Connection>,
}

impl RenderJobsState {
    fn open(db_path: PathBuf) -> rusqlite::Result<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS render_jobs (
                id TEXT PRIMARY KEY,
                project_external_id TEXT NOT NULL,
                format TEXT NOT NULL,
                mode TEXT NOT NULL,
                stage TEXT NOT NULL,
                bytes INTEGER NOT NULL DEFAULT 0,
                output_path TEXT,
                error TEXT,
                created_at INTEGER NOT NULL,
                finished_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_render_jobs_created_at
                ON render_jobs (created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_render_jobs_stage
                ON render_jobs (stage);",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    pub fn enqueue(
        &self,
        project_external_id: String,
        format: String,
        mode: String,
    ) -> rusqlite::Result<RenderJob> {
        let job = RenderJob {
            id: Uuid::new_v4().to_string(),
            project_external_id,
            format,
            mode,
            stage: "queued".to_string(),
            bytes: 0,
            output_path: None,
            error: None,
            created_at: Self::now_ms(),
            finished_at: None,
        };
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        conn.execute(
            "INSERT INTO render_jobs
                (id, project_external_id, format, mode, stage, bytes, output_path, error, created_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                job.id,
                job.project_external_id,
                job.format,
                job.mode,
                job.stage,
                job.bytes,
                job.output_path,
                job.error,
                job.created_at,
                job.finished_at,
            ],
        )?;
        Ok(job)
    }

    pub fn list(&self) -> rusqlite::Result<Vec<RenderJob>> {
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, project_external_id, format, mode, stage, bytes,
                    output_path, error, created_at, finished_at
             FROM render_jobs ORDER BY created_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([], row_to_job)?;
        rows.collect()
    }

    pub fn get(&self, id: &str) -> rusqlite::Result<Option<RenderJob>> {
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        let mut stmt = conn.prepare(
            "SELECT id, project_external_id, format, mode, stage, bytes,
                    output_path, error, created_at, finished_at
             FROM render_jobs WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], row_to_job)?;
        match rows.next() {
            Some(r) => r.map(Some),
            None => Ok(None),
        }
    }

    pub fn update_stage(
        &self,
        id: &str,
        stage: &str,
        bytes: Option<i64>,
        output_path: Option<&str>,
        error: Option<&str>,
    ) -> rusqlite::Result<()> {
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        let finished_at = if matches!(stage, "ready" | "error") {
            Some(Self::now_ms())
        } else {
            None
        };
        conn.execute(
            "UPDATE render_jobs
             SET stage = ?2,
                 bytes = COALESCE(?3, bytes),
                 output_path = COALESCE(?4, output_path),
                 error = ?5,
                 finished_at = COALESCE(?6, finished_at)
             WHERE id = ?1",
            params![id, stage, bytes, output_path, error, finished_at],
        )?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        let n = conn.execute("DELETE FROM render_jobs WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    pub fn clear_finished(&self) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        conn.execute(
            "DELETE FROM render_jobs WHERE stage IN ('done', 'error')",
            [],
        )
    }

    pub fn retry(&self, id: &str) -> rusqlite::Result<bool> {
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        let n = conn.execute(
            "UPDATE render_jobs
             SET stage = 'queued', error = NULL, finished_at = NULL
             WHERE id = ?1 AND stage = 'error'",
            params![id],
        )?;
        Ok(n > 0)
    }

    /// Anything left in `queued` or `uploading` when the app launches
    /// must be the casualty of a crash / forced quit. Flip it to error
    /// so the UI never spins forever on a job nobody owns.
    pub fn resume_pending(&self) -> rusqlite::Result<usize> {
        let conn = self.conn.lock().expect("render-jobs mutex poisoned");
        conn.execute(
            "UPDATE render_jobs
             SET stage = 'error',
                 error = COALESCE(error, 'interrupted by restart'),
                 finished_at = ?1
             WHERE stage IN ('queued', 'uploading')",
            params![Self::now_ms()],
        )
    }
}

fn row_to_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<RenderJob> {
    Ok(RenderJob {
        id: row.get(0)?,
        project_external_id: row.get(1)?,
        format: row.get(2)?,
        mode: row.get(3)?,
        stage: row.get(4)?,
        bytes: row.get(5)?,
        output_path: row.get(6)?,
        error: row.get(7)?,
        created_at: row.get(8)?,
        finished_at: row.get(9)?,
    })
}

pub fn init(app: &AppHandle) -> Result<RenderJobsState, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir unavailable: {e}"))?;
    let db_path = dir.join("render-jobs.sqlite");
    let state = RenderJobsState::open(db_path).map_err(|e| format!("open db failed: {e}"))?;
    let _ = state.resume_pending();
    Ok(state)
}

// ─── Tauri commands ──────────────────────────────────────────────────────

#[tauri::command]
pub fn enqueue_render(
    project_external_id: String,
    format: Option<String>,
    mode: Option<String>,
    state: State<'_, RenderJobsState>,
) -> Result<RenderJob, String> {
    let format = match format.as_deref() {
        Some("mp3") => "mp3".to_string(),
        _ => "wav".to_string(),
    };
    let mode = match mode.as_deref() {
        Some("native") => "native".to_string(),
        _ => "upload".to_string(),
    };
    state
        .enqueue(project_external_id, format, mode)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_render_jobs(state: State<'_, RenderJobsState>) -> Result<Vec<RenderJob>, String> {
    state.list().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_render_job(
    id: String,
    state: State<'_, RenderJobsState>,
) -> Result<Option<RenderJob>, String> {
    state.get(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_render_job(
    id: String,
    stage: String,
    bytes: Option<i64>,
    output_path: Option<String>,
    error: Option<String>,
    state: State<'_, RenderJobsState>,
) -> Result<(), String> {
    state
        .update_stage(&id, &stage, bytes, output_path.as_deref(), error.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_render_job(
    id: String,
    state: State<'_, RenderJobsState>,
) -> Result<bool, String> {
    state.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_render_jobs(state: State<'_, RenderJobsState>) -> Result<usize, String> {
    state.clear_finished().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn retry_render_job(
    id: String,
    state: State<'_, RenderJobsState>,
) -> Result<bool, String> {
    state.retry(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_render_output(
    id: String,
    state: State<'_, RenderJobsState>,
    app: AppHandle,
) -> Result<(), String> {
    let job = state
        .get(&id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("render job {id} not found"))?;
    let output = job
        .output_path
        .ok_or_else(|| "render job has no output path".to_string())?;
    let path = PathBuf::from(&output);
    let parent = path.parent().unwrap_or(&path).to_path_buf();
    let _ = app; // reserved for future shell integration
    open::that(parent).map_err(|e| e.to_string())
}
