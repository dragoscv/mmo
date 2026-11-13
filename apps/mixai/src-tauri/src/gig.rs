//! Gig lock (WP19-60): what the shell does for the lock that the webview cannot do itself.
//!
//! The lock lives in the webview (`src/gig/gig-store.ts`, stored in localStorage). The webview
//! tells the shell with `gig_set_locked` when it goes on or off, and again after every page
//! load, so the shell's copy follows it. The shell then does three things:
//!
//! 1. **Keep awake.** While locked, the system and the display stay awake. On Windows this is a
//!    power request (`PowerCreateRequest` + `PowerSetRequest`), not `SetThreadExecutionState`:
//!    that one belongs to the calling thread and ends with it, and Tauri runs commands on
//!    whatever thread it likes (the main thread for plain commands, pool threads for async
//!    ones). A power request is a handle of the process: no thread has to stay alive for it.
//!    It is released on unlock (`gig_set_locked(false)`), when the state is dropped, and by the
//!    OS when the process ends, however it ends. Other systems answer `unsupported`.
//! 2. **System status** (`gig_system_status`): mains / battery and the free space of the volume
//!    that holds a folder, for the checklist. Errors are values in the answer, never a failure
//!    of the command.
//! 3. **Close confirmation.** While locked, a close request of the MAIN window (title bar,
//!    Alt+F4, taskbar, a `WM_CLOSE` from anywhere) is held back and `gig://close-request` is
//!    emitted; the webview asks the DJ and calls `gig_close_window` to close for real. The
//!    webview must answer `gig_close_seen` when its question is on screen: a request that was
//!    never acknowledged stops holding the window after `CLOSE_PATIENCE`, so a dead or hung
//!    page can never trap the window (the next close request goes through).
//!
//!    This is decided here and not with a webview listener on Tauri's own
//!    `tauri://close-requested`: Tauri keeps a webview's event listeners until the WINDOW is
//!    destroyed, so after a page reload the old listener would still make Tauri refuse every
//!    close, with nobody left to answer it.
//!
//! Docs: `docs/decks/gig-mode.md`. Contract with the UI: `src/bridge/gig.ts`
//! (`src/gig/contract.test.ts` reads this file).

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Emitter, Manager, State};

use sys::GigSystemStatus;

/// Emitted to the main window when a close request was held back (no payload).
const CLOSE_EVENT: &str = "gig://close-request";
/// Label of the window the lock protects. Pop-out windows (`popout-*`) close without asking.
const MAIN_WINDOW: &str = "main";
/// How long an unacknowledged close question holds the window.
const CLOSE_PATIENCE: Duration = Duration::from_millis(1500);
/// Longest the disk query may take before the answer says "timed out" (a dying disk, a stale mount).
const DISK_TIMEOUT: Duration = Duration::from_secs(3);

/// Keep-awake as the UI shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepAwake {
    /// The system and the display are held awake.
    On,
    Off,
    /// This system has no keep-awake here (everything but Windows today).
    Unsupported,
    /// The system refused the request.
    Failed,
}

/// The shell's side of the lock (answer of `gig_status` and `gig_set_locked`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GigShell {
    pub locked: bool,
    pub keep_awake: KeepAwake,
}

/// Why a keep-awake request did not succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WakeError {
    // Windows always has a keep-awake; only the other systems answer this.
    #[cfg_attr(windows, allow(dead_code))]
    Unsupported,
    // Only Windows has a request that can fail.
    #[cfg_attr(not(windows), allow(dead_code))]
    Failed(String),
}

/// The keep-awake request, behind a trait so the lock logic is tested without the OS.
pub trait Wake {
    /// Whether this system can keep awake at all.
    fn supported(&self) -> bool;
    /// Hold the system and the display awake. Holding already = nothing to do.
    fn request(&mut self) -> Result<(), WakeError>;
    /// Let go. Not holding = nothing to do.
    fn release(&mut self);
    fn held(&self) -> bool;
}

/// What happens to a close request of the main window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CloseVerdict {
    /// Let the window close.
    Close,
    /// Hold it back and ask the DJ.
    Ask,
}

/// The close question that is out, if any.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct CloseAsk {
    /// When the question was sent to the webview.
    asked_at: Option<Instant>,
    /// The webview said the question is on screen.
    seen: bool,
}

/// Decide a close request of the main window at `now`.
///
/// Unlocked: close. Locked: ask, unless a question has been out for `CLOSE_PATIENCE` without
/// the webview acknowledging it; then the page is not answering and the window closes. A
/// repeated request does not move the time of a question that is still unanswered (hammering
/// Alt+F4 must not push the way out further away).
fn on_close_request(locked: bool, ask: &mut CloseAsk, now: Instant) -> CloseVerdict {
    if !locked {
        *ask = CloseAsk::default();
        return CloseVerdict::Close;
    }
    if let Some(at) = ask.asked_at
        && !ask.seen
    {
        if now.saturating_duration_since(at) >= CLOSE_PATIENCE {
            *ask = CloseAsk::default();
            return CloseVerdict::Close;
        }
        return CloseVerdict::Ask;
    }
    *ask = CloseAsk {
        asked_at: Some(now),
        seen: false,
    };
    CloseVerdict::Ask
}

struct Inner<W: Wake> {
    locked: bool,
    wake: W,
    keep_awake: KeepAwake,
    close: CloseAsk,
}

impl<W: Wake> Inner<W> {
    fn new(wake: W) -> Self {
        let keep_awake = if wake.supported() {
            KeepAwake::Off
        } else {
            KeepAwake::Unsupported
        };
        Self {
            locked: false,
            wake,
            keep_awake,
            close: CloseAsk::default(),
        }
    }

    fn status(&self) -> GigShell {
        GigShell {
            locked: self.locked,
            keep_awake: self.keep_awake,
        }
    }

    /// Follow the webview's lock. Idempotent: locking twice holds one request, and one unlock
    /// releases it. A failed request is tried again by the next `set_locked(true)`.
    fn set_locked(&mut self, locked: bool) -> GigShell {
        self.locked = locked;
        if locked {
            if !self.wake.held() {
                self.keep_awake = match self.wake.request() {
                    Ok(()) => KeepAwake::On,
                    Err(WakeError::Unsupported) => KeepAwake::Unsupported,
                    Err(WakeError::Failed(e)) => {
                        log::warn!("gig lock: keep-awake was refused: {e}");
                        KeepAwake::Failed
                    }
                };
            }
        } else {
            self.wake.release();
            self.keep_awake = if self.wake.supported() {
                KeepAwake::Off
            } else {
                KeepAwake::Unsupported
            };
            // No question survives the lock.
            self.close = CloseAsk::default();
        }
        self.status()
    }
}

/// Tauri-managed state of the gig lock.
pub struct GigCtl(Mutex<Inner<sys::WakeLock>>);

impl Default for GigCtl {
    fn default() -> Self {
        Self(Mutex::new(Inner::new(sys::WakeLock::new())))
    }
}

impl GigCtl {
    /// A panic while the lock was held must not take the gig lock down with it: the data is
    /// three plain fields and a handle, valid at every step.
    fn lock(&self) -> MutexGuard<'_, Inner<sys::WakeLock>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Called once from the app setup: watches close requests of the main window.
pub fn init(app: &tauri::AppHandle) {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        log::warn!("gig lock: no main window, closing will not ask while locked");
        return;
    };
    let handle = app.clone();
    main.on_window_event(move |event| {
        let tauri::WindowEvent::CloseRequested { api, .. } = event else {
            return;
        };
        let ctl: State<'_, GigCtl> = handle.state();
        let verdict = {
            let mut inner = ctl.lock();
            let locked = inner.locked;
            on_close_request(locked, &mut inner.close, Instant::now())
        };
        if verdict == CloseVerdict::Ask {
            api.prevent_close();
            // If this fails nobody acknowledges, and the next request after CLOSE_PATIENCE closes.
            if let Err(e) = handle.emit_to(MAIN_WINDOW, CLOSE_EVENT, ()) {
                log::warn!("gig lock: could not ask the window before closing: {e}");
            }
        }
    });
}

// ---- commands ----------------------------------------------------------------------------

/// The shell's copy of the lock and the keep-awake state.
#[tauri::command]
pub fn gig_status(ctl: State<'_, GigCtl>) -> GigShell {
    ctl.lock().status()
}

/// Lock / unlock: keep-awake is requested while locked and released on unlock; close requests
/// of the main window ask first while locked. Safe to call again with the same value.
#[tauri::command]
pub fn gig_set_locked(locked: bool, ctl: State<'_, GigCtl>) -> GigShell {
    ctl.lock().set_locked(locked)
}

/// Power source and the free space of the volume that holds `path` (an absolute folder path;
/// `None` = the user's Documents folder, where a first recording is offered). Never fails:
/// what could not be read is `unknown` / an error code in the answer.
#[tauri::command]
pub async fn gig_system_status(path: Option<String>, app: tauri::AppHandle) -> GigSystemStatus {
    let folder = path.or_else(|| default_folder(&app));
    // Off the async runtime: a disk that hangs must not hold a runtime thread, and the answer
    // comes back after DISK_TIMEOUT at the latest. Power and disk are asked side by side, each
    // with its own limit, so a slow disk never costs the power answer.
    let power = tauri::async_runtime::spawn_blocking(sys::power_status);
    let disk = tauri::async_runtime::spawn_blocking(move || sys::disk_for(folder.as_deref()));
    let power = match tokio::time::timeout(DISK_TIMEOUT, power).await {
        Ok(Ok(p)) => p,
        _ => sys::PowerStatus::UNKNOWN,
    };
    let disk = match tokio::time::timeout(DISK_TIMEOUT, disk).await {
        Ok(Ok(d)) => d,
        Ok(Err(_)) => sys::disk_error(sys::err::QUERY_FAILED),
        Err(_) => sys::disk_error(sys::err::TIMEOUT),
    };
    GigSystemStatus { power, disk }
}

/// The webview's close question is on screen (see `on_close_request`).
#[tauri::command]
pub fn gig_close_seen(ctl: State<'_, GigCtl>) {
    let mut inner = ctl.lock();
    if inner.close.asked_at.is_some() {
        inner.close.seen = true;
    }
}

/// Close the calling window for real, without a close request (the DJ chose "close anyway").
/// Async: destroying a window from a plain command would run on the main thread it tears down.
#[tauri::command]
pub async fn gig_close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

fn default_folder(app: &tauri::AppHandle) -> Option<String> {
    let dir = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .ok()?;
    dir.to_str().map(str::to_owned)
}

// ---- platform ----------------------------------------------------------------------------
// Nothing below uses Tauri, so this module can be compiled and checked alone for each system.

mod sys {
    use std::path::Path;

    use serde::Serialize;

    use super::{Wake, WakeError};

    /// What the computer runs on.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    // Systems that do not read the power source (macOS today) only ever answer `Unknown`.
    #[cfg_attr(not(any(windows, target_os = "linux", test)), allow(dead_code))]
    pub enum PowerSource {
        Mains,
        Battery,
        Unknown,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PowerStatus {
        pub source: PowerSource,
        /// Battery charge 0..100 when the system reports one.
        pub percent: Option<u8>,
        pub charging: Option<bool>,
    }

    impl PowerStatus {
        pub const UNKNOWN: Self = Self {
            source: PowerSource::Unknown,
            percent: None,
            charging: None,
        };
    }

    #[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DiskStatus {
        /// The folder that was asked about (cut to `SHOWN_PATH_CHARS`).
        pub path: Option<String>,
        /// Bytes this user can still write on that volume.
        pub free_bytes: Option<u64>,
        pub total_bytes: Option<u64>,
        /// A network location: its free space is NOT asked for (a dead share blocks for a long
        /// time), and recording there depends on the network.
        pub network: bool,
        /// Why there are no numbers: one of the codes in [`err`] (the UI words them; no English
        /// prose crosses the bridge).
        pub error: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct GigSystemStatus {
        pub power: PowerStatus,
        pub disk: DiskStatus,
    }

    /// Longest path accepted (characters). Windows long paths go up to 32 767 UTF-16 units; a
    /// recording folder that deep is not one.
    pub const MAX_PATH_CHARS: usize = 4096;
    /// How much of the path is echoed back.
    pub const SHOWN_PATH_CHARS: usize = 260;

    /// Error codes of [`DiskStatus::error`] (mirrored in `src/gig/gig-core.ts` `DISK_ERRORS`;
    /// `src/gig/contract.test.ts` compares the two lists).
    pub mod err {
        pub const EMPTY: &str = "empty";
        pub const TOO_LONG: &str = "tooLong";
        pub const NUL: &str = "nul";
        pub const RELATIVE: &str = "relative";
        /// `\\.\...`: a device or pipe namespace, never a recording folder.
        pub const DEVICE: &str = "device";
        pub const MISSING: &str = "missing";
        pub const NOT_FOLDER: &str = "notFolder";
        pub const QUERY_FAILED: &str = "queryFailed";
        pub const TIMEOUT: &str = "timeout";
        pub const NO_FOLDER: &str = "noFolder";
        // Only systems without a free-space query answer this (none of the three we build for).
        #[cfg_attr(any(windows, unix), allow(dead_code))]
        pub const UNSUPPORTED: &str = "unsupported";
    }

    /// The disk part of the answer for `folder` (`None` = no folder could be worked out).
    pub fn disk_for(folder: Option<&str>) -> DiskStatus {
        match folder {
            Some(f) => disk_status(f),
            None => disk_error(err::NO_FOLDER),
        }
    }

    /// A disk answer that is only an error code.
    pub fn disk_error(code: &str) -> DiskStatus {
        DiskStatus {
            error: Some(code.into()),
            ..DiskStatus::default()
        }
    }

    // ---- path checks (text only: nothing here touches a disk or the network) ----

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum PathKind {
        Local,
        Network,
    }

    /// A Windows network path by its text: `\\server\share`, `//server/share`,
    /// `\\?\UNC\server\share`. `\\?\C:\...` (a long local path) and `\\.\...` (a device) are not.
    pub fn is_unc_text(raw: &str) -> bool {
        let s = raw.replace('/', "\\");
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest
                .get(..4)
                .is_some_and(|p| p.eq_ignore_ascii_case(r"UNC\"));
        }
        if s.starts_with(r"\\.\") {
            return false;
        }
        s.starts_with(r"\\")
    }

    /// Validate the folder argument before anything is asked of the system. `windows` = apply
    /// the Windows rules (a parameter so both sets of rules are tested on any system).
    pub fn check_path_for(raw: &str, windows: bool) -> Result<PathKind, &'static str> {
        if raw.is_empty() {
            return Err(err::EMPTY);
        }
        if raw.chars().count() > MAX_PATH_CHARS {
            return Err(err::TOO_LONG);
        }
        if raw.contains('\0') {
            return Err(err::NUL);
        }
        // Device / pipe namespace (`\\.\pipe\x`, `\\.\PhysicalDrive0`, `\\.\UNC\server\share`):
        // `fs::metadata` on those can open a pipe or reach a share. Never a recording folder.
        if windows && raw.replace('/', "\\").starts_with(r"\\.\") {
            return Err(err::DEVICE);
        }
        if windows && is_unc_text(raw) {
            return Ok(PathKind::Network);
        }
        let absolute = if windows == cfg!(windows) {
            Path::new(raw).is_absolute()
        } else if windows {
            windows_absolute_text(raw)
        } else {
            raw.starts_with('/')
        };
        if absolute {
            Ok(PathKind::Local)
        } else {
            Err(err::RELATIVE)
        }
    }

    /// `C:\...` / `C:/...` or a `\\?\` path: absolute on Windows (used only when the Windows
    /// rules are tested on another system).
    fn windows_absolute_text(raw: &str) -> bool {
        let b = raw.as_bytes();
        let drive = b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && (b[2] == b'\\' || b[2] == b'/');
        drive || raw.starts_with(r"\\?\")
    }

    pub fn check_path(raw: &str) -> Result<PathKind, &'static str> {
        check_path_for(raw, cfg!(windows))
    }

    /// Free and total space of the volume holding the folder `raw`; every failure is a value.
    pub fn disk_status(raw: &str) -> DiskStatus {
        let mut out = DiskStatus {
            path: Some(raw.chars().take(SHOWN_PATH_CHARS).collect()),
            ..DiskStatus::default()
        };
        match check_path(raw) {
            Err(e) => out.error = Some(e.into()),
            Ok(PathKind::Network) => out.network = true,
            Ok(PathKind::Local) => match volume_space(Path::new(raw)) {
                Ok(Space::Network) => out.network = true,
                Ok(Space::Bytes { free, total }) => {
                    out.free_bytes = Some(free);
                    out.total_bytes = Some(total);
                }
                Err(e) => out.error = Some(e),
            },
        }
        out
    }

    enum Space {
        Bytes {
            free: u64,
            total: u64,
        },
        /// A mapped network drive (Windows).
        #[cfg_attr(not(windows), allow(dead_code))]
        Network,
    }

    /// The folder must exist and be a folder (a local path: `check_path` and the drive type
    /// were checked first, so this does not reach for the network).
    #[cfg(any(windows, unix))]
    fn must_be_folder(dir: &Path) -> Result<(), String> {
        let meta = std::fs::metadata(dir).map_err(|_| err::MISSING.to_string())?;
        if meta.is_dir() {
            Ok(())
        } else {
            Err(err::NOT_FOLDER.into())
        }
    }

    // ---- Windows ----

    /// `GetDriveTypeW`: a remote (network) drive. Value from winbase.h (the windows-sys constant
    /// sits behind one more feature).
    #[cfg(windows)]
    const DRIVE_REMOTE: u32 = 4;
    /// `REASON_CONTEXT.Version` (winnt.h `POWER_REQUEST_CONTEXT_VERSION`).
    #[cfg(windows)]
    const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;

    #[cfg(windows)]
    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// `C:\` for a path on drive C (also for the long form `\\?\C:\...`); `None` for anything
    /// that is not on a drive letter.
    #[cfg(windows)]
    pub fn drive_root(dir: &Path) -> Option<String> {
        use std::path::{Component, Prefix};
        match dir.components().next()? {
            Component::Prefix(p) => match p.kind() {
                Prefix::Disk(b) | Prefix::VerbatimDisk(b) => {
                    Some(format!("{}:\\", char::from(b.to_ascii_uppercase())))
                }
                _ => None,
            },
            _ => None,
        }
    }

    #[cfg(windows)]
    fn volume_space(dir: &Path) -> Result<Space, String> {
        use windows_sys::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW};

        let root = drive_root(dir).map(|r| wide(std::ffi::OsStr::new(&r)));
        if let Some(root) = &root {
            // SAFETY: `root` is a NUL-terminated UTF-16 string that outlives the call. The drive
            // type is read from the local drive table: no network round trip.
            if unsafe { GetDriveTypeW(root.as_ptr()) } == DRIVE_REMOTE {
                return Ok(Space::Network);
            }
        }
        must_be_folder(dir)?;
        let query = |path: &[u16]| -> Option<(u64, u64)> {
            let mut free = 0u64;
            let mut total = 0u64;
            // SAFETY: `path` is NUL-terminated UTF-16 (`wide`), the two out pointers are valid
            // for the call, and the third (total free bytes) is optional.
            let ok = unsafe {
                GetDiskFreeSpaceExW(path.as_ptr(), &mut free, &mut total, std::ptr::null_mut())
            };
            (ok != 0).then_some((free, total))
        };
        // The folder itself first (it may be a mount point of another volume); a path longer
        // than the classic limit can be refused there, then the drive root answers.
        let found = query(&wide(dir.as_os_str())).or_else(|| root.as_deref().and_then(query));
        match found {
            Some((free, total)) => Ok(Space::Bytes { free, total }),
            None => Err(err::QUERY_FAILED.into()),
        }
    }

    /// `SYSTEM_POWER_STATUS` -> power status. `ac`: 0 battery, 1 mains, 255 unknown. `flag`:
    /// bit 8 charging, bit 128 no system battery, 255 unknown. `percent`: 0..100, 255 unknown.
    #[cfg(any(windows, test))]
    pub fn power_from_windows(ac: u8, flag: u8, percent: u8) -> PowerStatus {
        let source = match ac {
            0 => PowerSource::Battery,
            1 => PowerSource::Mains,
            _ => PowerSource::Unknown,
        };
        let flag_known = flag != 255;
        let no_battery = flag_known && flag & 128 != 0;
        PowerStatus {
            source,
            percent: (!no_battery && percent <= 100).then_some(percent),
            charging: (flag_known && !no_battery).then_some(flag & 8 != 0),
        }
    }

    #[cfg(windows)]
    pub fn power_status() -> PowerStatus {
        use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

        let mut st = SYSTEM_POWER_STATUS {
            ACLineStatus: 255,
            BatteryFlag: 255,
            BatteryLifePercent: 255,
            SystemStatusFlag: 0,
            BatteryLifeTime: 0,
            BatteryFullLifeTime: 0,
        };
        // SAFETY: `st` is a valid, writable SYSTEM_POWER_STATUS for the duration of the call.
        if unsafe { GetSystemPowerStatus(&mut st) } == 0 {
            return PowerStatus::UNKNOWN;
        }
        power_from_windows(st.ACLineStatus, st.BatteryFlag, st.BatteryLifePercent)
    }

    /// A Windows power request that keeps the system and the display awake. The handle is kept
    /// as an integer so the state is `Send` (a handle is not tied to a thread).
    #[cfg(windows)]
    #[derive(Default)]
    pub struct WakeLock(Option<isize>);

    #[cfg(windows)]
    impl WakeLock {
        pub fn new() -> Self {
            Self(None)
        }
    }

    #[cfg(windows)]
    impl Wake for WakeLock {
        fn supported(&self) -> bool {
            true
        }

        fn request(&mut self) -> Result<(), WakeError> {
            use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
            use windows_sys::Win32::System::Power::{
                PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
                PowerRequestSystemRequired, PowerSetRequest,
            };
            use windows_sys::Win32::System::Threading::{
                POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
            };

            if self.0.is_some() {
                return Ok(());
            }
            let failed = || WakeError::Failed(std::io::Error::last_os_error().to_string());
            // Shown by `powercfg /requests`.
            let mut reason = wide(std::ffi::OsStr::new("MixAI Decks: gig lock is on"));
            let context = REASON_CONTEXT {
                Version: POWER_REQUEST_CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: reason.as_mut_ptr(),
                },
            };
            // SAFETY: `context` and the string it points to are valid for the call; the system
            // copies the reason.
            let handle = unsafe { PowerCreateRequest(&context) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(failed());
            }
            // SAFETY: `handle` is the live power request created above.
            let ok = unsafe {
                PowerSetRequest(handle, PowerRequestDisplayRequired) != 0
                    && PowerSetRequest(handle, PowerRequestSystemRequired) != 0
            };
            if !ok {
                let e = failed();
                // SAFETY: same live handle; clearing a request that was not set is harmless,
                // and the handle is not used after CloseHandle.
                unsafe {
                    PowerClearRequest(handle, PowerRequestDisplayRequired);
                    PowerClearRequest(handle, PowerRequestSystemRequired);
                    CloseHandle(handle);
                }
                return Err(e);
            }
            self.0 = Some(handle as isize);
            Ok(())
        }

        fn release(&mut self) {
            use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
            use windows_sys::Win32::System::Power::{
                PowerClearRequest, PowerRequestDisplayRequired, PowerRequestSystemRequired,
            };

            let Some(raw) = self.0.take() else {
                return;
            };
            let handle = raw as HANDLE;
            // SAFETY: `raw` came from PowerCreateRequest in `request` and was taken out of
            // `self`, so it is closed exactly once.
            unsafe {
                PowerClearRequest(handle, PowerRequestDisplayRequired);
                PowerClearRequest(handle, PowerRequestSystemRequired);
                CloseHandle(handle);
            }
        }

        fn held(&self) -> bool {
            self.0.is_some()
        }
    }

    #[cfg(windows)]
    impl Drop for WakeLock {
        fn drop(&mut self) {
            self.release();
        }
    }

    // ---- everything else: no keep-awake ----

    #[cfg(not(windows))]
    pub struct WakeLock;

    #[cfg(not(windows))]
    impl WakeLock {
        /// `WakeLock::default()` on a unit struct is clippy's `default_constructed_unit_structs`
        /// (it fired on the Linux CI job): construct it directly instead.
        pub fn new() -> Self {
            Self
        }
    }

    #[cfg(not(windows))]
    impl Wake for WakeLock {
        fn supported(&self) -> bool {
            false
        }

        fn request(&mut self) -> Result<(), WakeError> {
            Err(WakeError::Unsupported)
        }

        fn release(&mut self) {}

        fn held(&self) -> bool {
            false
        }
    }

    // ---- unix: free space through statvfs ----

    #[cfg(unix)]
    // The fields of `statvfs` are u64 on Linux and narrower on macOS: the casts are needed on
    // one system and flagged as unnecessary on the other.
    #[allow(clippy::unnecessary_cast)]
    fn volume_space(dir: &Path) -> Result<Space, String> {
        use std::os::unix::ffi::OsStrExt;

        must_be_folder(dir)?;
        let path =
            std::ffi::CString::new(dir.as_os_str().as_bytes()).map_err(|_| err::NUL.to_string())?;
        let mut st = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
        // SAFETY: `path` is a valid C string and `st` is writable memory of the right size.
        if unsafe { libc::statvfs(path.as_ptr(), st.as_mut_ptr()) } != 0 {
            return Err(err::QUERY_FAILED.into());
        }
        // SAFETY: statvfs returned 0, so it filled the struct.
        let st = unsafe { st.assume_init() };
        let block = st.f_frsize as u64;
        Ok(Space::Bytes {
            free: (st.f_bavail as u64).saturating_mul(block),
            total: (st.f_blocks as u64).saturating_mul(block),
        })
    }

    #[cfg(not(any(windows, unix)))]
    fn volume_space(_dir: &Path) -> Result<Space, String> {
        Err(err::UNSUPPORTED.into())
    }

    // ---- Linux: battery from /sys/class/power_supply ----

    /// One entry of `/sys/class/power_supply`.
    #[cfg(any(target_os = "linux", test))]
    #[derive(Debug, Clone, Default, PartialEq, Eq)]
    pub struct Supply {
        /// `type`: "Battery", "Mains", "USB", ...
        pub kind: String,
        /// `online` (chargers).
        pub online: Option<bool>,
        /// `capacity` (batteries), percent.
        pub capacity: Option<u8>,
        /// `status` (batteries): "Charging", "Discharging", "Full", "Not charging", "Unknown".
        pub status: Option<String>,
        /// `scope` is "Device": the battery of a mouse or a headset, not of the computer.
        pub device: bool,
    }

    #[cfg(any(target_os = "linux", test))]
    pub fn power_from_supplies(items: &[Supply]) -> PowerStatus {
        let battery = items.iter().find(|s| s.kind == "Battery" && !s.device);
        let chargers = || items.iter().filter(|s| s.kind != "Battery");
        let charger_online = chargers().any(|s| s.online == Some(true));
        let charger_known = chargers().any(|s| s.online.is_some());
        let status = battery.and_then(|b| b.status.as_deref());
        // A charger that reports itself decides first: "Full" and "Not charging" are also what
        // a battery says in the first seconds after the plug is pulled, and the second battery
        // of a dual-battery laptop says "Not charging" while the first one drains.
        let source = match status {
            _ if charger_online => PowerSource::Mains,
            _ if charger_known && battery.is_some() => PowerSource::Battery,
            Some("Discharging") => PowerSource::Battery,
            Some("Charging" | "Full" | "Not charging") => PowerSource::Mains,
            _ => PowerSource::Unknown,
        };
        PowerStatus {
            source,
            percent: battery.and_then(|b| b.capacity).filter(|p| *p <= 100),
            charging: match status {
                Some("Charging") => Some(true),
                Some("Discharging" | "Full" | "Not charging") => Some(false),
                _ => None,
            },
        }
    }

    #[cfg(target_os = "linux")]
    pub fn power_status() -> PowerStatus {
        let Ok(dir) = std::fs::read_dir("/sys/class/power_supply") else {
            return PowerStatus::UNKNOWN;
        };
        let read = |base: &Path, name: &str| {
            std::fs::read_to_string(base.join(name))
                .ok()
                .map(|s| s.trim().to_owned())
        };
        // A laptop has two or three entries; the cap only bounds a broken sysfs.
        let items: Vec<Supply> = dir
            .flatten()
            .take(32)
            .map(|e| {
                let p = e.path();
                Supply {
                    kind: read(&p, "type").unwrap_or_default(),
                    online: read(&p, "online").map(|v| v == "1"),
                    capacity: read(&p, "capacity").and_then(|v| v.parse().ok()),
                    status: read(&p, "status"),
                    device: read(&p, "scope").as_deref() == Some("Device"),
                }
            })
            .collect();
        power_from_supplies(&items)
    }

    /// macOS and the rest: the power source is not read this round.
    #[cfg(not(any(windows, target_os = "linux")))]
    pub fn power_status() -> PowerStatus {
        PowerStatus::UNKNOWN
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn network_paths_are_recognised_by_their_text_alone() {
            for p in [
                r"\\server\share",
                r"\\server\share\sets",
                "//server/share/sets",
                r"\\?\UNC\server\share",
                r"\\?\unc\server\share",
                r"\\192.168.1.2\d$",
            ] {
                assert!(is_unc_text(p), "{p:?} is a network path");
            }
            for p in [
                r"C:\sets",
                r"\\?\C:\a very long\path",
                r"\\.\PhysicalDrive0",
                r"\\?\",
                r"\\?\UN",
                r"\\?\é",
                r"\sets",
                "sets",
                "",
                "/home/dj/sets",
            ] {
                assert!(!is_unc_text(p), "{p:?} is not a network path");
            }
        }

        #[test]
        fn the_folder_argument_is_validated_before_anything_is_asked() {
            // Windows rules.
            assert_eq!(check_path_for(r"C:\sets", true), Ok(PathKind::Local));
            assert_eq!(check_path_for("C:/sets", true), Ok(PathKind::Local));
            assert_eq!(check_path_for(r"\\?\C:\sets", true), Ok(PathKind::Local));
            assert_eq!(check_path_for(r"\\nas\sets", true), Ok(PathKind::Network));
            assert_eq!(
                check_path_for(r"\\?\UNC\nas\sets", true),
                Ok(PathKind::Network)
            );
            for relative in [
                "sets",
                r".\sets",
                r"..\..\Windows",
                "C:",
                "C:sets",
                r"\sets",
            ] {
                assert_eq!(
                    check_path_for(relative, true),
                    Err(err::RELATIVE),
                    "{relative:?}"
                );
            }
            // The device / pipe namespace is refused before anything is asked (with either slash).
            for device in [
                r"\\.\pipe\mixai",
                r"\\.\PhysicalDrive0",
                r"\\.\UNC\server\share",
                r"\\.\C:\sets",
                "//./pipe/x",
            ] {
                assert_eq!(check_path_for(device, true), Err(err::DEVICE), "{device:?}");
                // `disk_status` asks the real system: the device namespace is a Windows rule, so on
                // macOS and Linux the same path is merely relative (the CI macOS job caught this).
                #[cfg(windows)]
                assert_eq!(disk_status(device).error.as_deref(), Some(err::DEVICE));
                #[cfg(not(windows))]
                let _ = device;
            }
            // Unix rules: a leading slash, and `//server/share` is an ordinary local path.
            assert_eq!(check_path_for("/home/dj/sets", false), Ok(PathKind::Local));
            assert_eq!(check_path_for("//server/share", false), Ok(PathKind::Local));
            assert_eq!(check_path_for("home/dj", false), Err(err::RELATIVE));
            assert_eq!(check_path_for(r"C:\sets", false), Err(err::RELATIVE));
            // Both.
            for windows in [true, false] {
                assert_eq!(check_path_for("", windows), Err(err::EMPTY));
                assert_eq!(check_path_for("/a\0b", windows), Err(err::NUL));
                assert_eq!(
                    check_path_for(r"C:\a\0b", windows).is_ok(),
                    windows,
                    "a backslash and a zero digit are not a NUL"
                );
                let long = format!("/{}", "a".repeat(MAX_PATH_CHARS));
                assert_eq!(check_path_for(&long, windows), Err(err::TOO_LONG));
                let fits = format!("/{}", "é".repeat(MAX_PATH_CHARS - 1));
                assert_ne!(
                    check_path_for(&fits, windows),
                    Err(err::TOO_LONG),
                    "the limit counts characters, not bytes"
                );
            }
            // Every code is short camelCase text the UI can look up (no prose, no spaces).
            for code in [
                err::EMPTY,
                err::TOO_LONG,
                err::NUL,
                err::RELATIVE,
                err::DEVICE,
                err::MISSING,
                err::NOT_FOLDER,
                err::QUERY_FAILED,
                err::TIMEOUT,
                err::NO_FOLDER,
                err::UNSUPPORTED,
            ] {
                assert!(
                    code.len() < 16 && code.chars().all(|c| c.is_ascii_alphabetic()),
                    "{code:?}"
                );
            }
            assert_eq!(disk_for(None).error.as_deref(), Some(err::NO_FOLDER));
        }

        #[test]
        fn odd_input_is_an_error_value_never_a_panic_and_never_a_disk_query() {
            for raw in [
                "",
                " ",
                "\0",
                "relative/path",
                "..",
                "C:",
                r"\\?\",
                r"\\?\é",
                "\u{feff}",
                "💿",
                "a\0b",
            ] {
                let d = disk_status(raw);
                assert!(d.error.is_some(), "{raw:?} must be refused");
                assert_eq!(d.free_bytes, None);
                assert_eq!(d.total_bytes, None);
                assert!(!d.network);
            }
            let long = "x".repeat(100_000);
            let d = disk_status(&long);
            assert_eq!(d.error.as_deref(), Some(err::TOO_LONG));
            assert_eq!(
                d.path.as_deref().map(|p| p.chars().count()),
                Some(SHOWN_PATH_CHARS),
                "the echoed path is cut"
            );
        }

        #[test]
        fn a_folder_that_does_not_exist_or_is_a_file_is_an_error_value() {
            let missing = std::env::temp_dir().join("mixai-gig-test-no-such-folder-7f3a");
            let d = disk_status(missing.to_str().unwrap());
            assert_eq!(d.error.as_deref(), Some(err::MISSING), "{d:?}");
            assert_eq!(d.free_bytes, None);

            let file =
                std::env::temp_dir().join(format!("mixai-gig-test-{}.txt", std::process::id()));
            std::fs::write(&file, b"x").unwrap();
            let d = disk_status(file.to_str().unwrap());
            let _ = std::fs::remove_file(&file);
            assert_eq!(d.error.as_deref(), Some(err::NOT_FOLDER), "{d:?}");
        }

        /// The real API on this machine: the temp folder is on a local volume with some room.
        #[cfg(any(windows, unix))]
        #[test]
        fn the_temp_folder_reports_free_space_within_its_volume() {
            let tmp = std::env::temp_dir();
            let d = disk_status(tmp.to_str().expect("temp dir is valid UTF-8"));
            assert_eq!(d.error, None, "{d:?}");
            assert!(!d.network);
            let free = d.free_bytes.expect("free bytes");
            let total = d.total_bytes.expect("total bytes");
            assert!(free > 0, "free {free}");
            assert!(total > 0, "total {total}");
            assert!(free <= total, "free {free} > total {total}");
        }

        /// The real API: whatever this machine is, the answer is well-formed and stable, and on
        /// Windows (where every machine answers `GetSystemPowerStatus`) the source is known.
        #[test]
        fn the_power_status_of_this_machine_is_well_formed() {
            let p = power_status();
            if let Some(pct) = p.percent {
                assert!(pct <= 100, "{p:?}");
            }
            // No battery percent without a battery reading, and charging only with a source.
            if p.source == PowerSource::Unknown {
                assert_eq!(p.charging, None, "{p:?}");
            }
            #[cfg(windows)]
            assert_ne!(
                p.source,
                PowerSource::Unknown,
                "Windows always reports AC or battery: {p:?}"
            );
            let again = power_status();
            assert_eq!(p.source, again.source, "two reads a moment apart agree");
        }

        #[cfg(windows)]
        #[test]
        fn a_drive_root_is_found_for_plain_and_long_paths_only() {
            assert_eq!(drive_root(Path::new(r"c:\sets\a")).as_deref(), Some(r"C:\"));
            assert_eq!(
                drive_root(Path::new(r"\\?\D:\sets")).as_deref(),
                Some(r"D:\")
            );
            assert_eq!(drive_root(Path::new(r"\\nas\share\sets")), None);
            assert_eq!(drive_root(Path::new(r"\sets")), None);
            assert_eq!(drive_root(Path::new("sets")), None);
        }

        #[test]
        fn windows_power_bytes_map_to_a_status() {
            let s = |source, percent, charging| PowerStatus {
                source,
                percent,
                charging,
            };
            // Laptop on the charger, charging at 80 %.
            assert_eq!(
                power_from_windows(1, 8, 80),
                s(PowerSource::Mains, Some(80), Some(true))
            );
            // Laptop on the charger, full (flag 1 = high, not charging).
            assert_eq!(
                power_from_windows(1, 1, 100),
                s(PowerSource::Mains, Some(100), Some(false))
            );
            // On battery, low.
            assert_eq!(
                power_from_windows(0, 2, 19),
                s(PowerSource::Battery, Some(19), Some(false))
            );
            // Desktop: no system battery, percent 255.
            assert_eq!(
                power_from_windows(1, 128, 255),
                s(PowerSource::Mains, None, None)
            );
            // "No battery" wins over a stray percent.
            assert_eq!(
                power_from_windows(1, 128, 50),
                s(PowerSource::Mains, None, None)
            );
            // Nothing known.
            assert_eq!(power_from_windows(255, 255, 255), PowerStatus::UNKNOWN);
            // Unknown flag, known percent.
            assert_eq!(
                power_from_windows(0, 255, 40),
                s(PowerSource::Battery, Some(40), None)
            );
            // Percent out of range is dropped, 100 is kept.
            assert_eq!(power_from_windows(0, 0, 101).percent, None);
            assert_eq!(power_from_windows(0, 0, 100).percent, Some(100));
            assert_eq!(power_from_windows(0, 0, 0).percent, Some(0));
        }

        #[test]
        fn linux_power_supplies_map_to_a_status() {
            let bat = |status: &str, capacity: u8| Supply {
                kind: "Battery".into(),
                capacity: Some(capacity),
                status: Some(status.into()),
                ..Supply::default()
            };
            let ac = |online: bool| Supply {
                kind: "Mains".into(),
                online: Some(online),
                ..Supply::default()
            };
            let p = power_from_supplies(&[ac(true), bat("Charging", 61)]);
            assert_eq!(
                (p.source, p.percent, p.charging),
                (PowerSource::Mains, Some(61), Some(true))
            );
            let p = power_from_supplies(&[ac(false), bat("Discharging", 18)]);
            assert_eq!(
                (p.source, p.percent, p.charging),
                (PowerSource::Battery, Some(18), Some(false))
            );
            let p = power_from_supplies(&[ac(true), bat("Full", 100)]);
            assert_eq!((p.source, p.charging), (PowerSource::Mains, Some(false)));
            // The charger decides before the battery's own words (P1-8): unplugged a moment ago,
            // the battery still says "Full" / "Not charging".
            for status in ["Full", "Not charging", "Charging"] {
                let p = power_from_supplies(&[ac(false), bat(status, 97)]);
                assert_eq!(
                    p.source,
                    PowerSource::Battery,
                    "charger offline, battery {status:?}"
                );
            }
            // Dual battery: the second one idles ("Not charging") while the first drains.
            let p =
                power_from_supplies(&[ac(false), bat("Not charging", 80), bat("Discharging", 60)]);
            assert_eq!(p.source, PowerSource::Battery);
            // A USB-C charger online counts as mains even when the "Mains" entry is offline.
            let usb = Supply {
                kind: "USB".into(),
                online: Some(true),
                ..Supply::default()
            };
            assert_eq!(
                power_from_supplies(&[ac(false), usb, bat("Charging", 50)]).source,
                PowerSource::Mains
            );
            // No charger entry at all: the battery's status is all there is.
            assert_eq!(
                power_from_supplies(&[bat("Full", 100)]).source,
                PowerSource::Mains
            );
            assert_eq!(
                power_from_supplies(&[bat("Discharging", 40)]).source,
                PowerSource::Battery
            );
            // A battery whose status says nothing: the charger decides.
            let p = power_from_supplies(&[ac(false), bat("Unknown", 50)]);
            assert_eq!((p.source, p.charging), (PowerSource::Battery, None));
            // Desktop: mains only, or nothing at all.
            assert_eq!(
                power_from_supplies(&[ac(true)]),
                PowerStatus {
                    source: PowerSource::Mains,
                    percent: None,
                    charging: None
                }
            );
            assert_eq!(power_from_supplies(&[]), PowerStatus::UNKNOWN);
            // The battery of a mouse is not the computer's.
            let mouse = Supply {
                device: true,
                ..bat("Discharging", 7)
            };
            assert_eq!(
                power_from_supplies(std::slice::from_ref(&mouse)),
                PowerStatus::UNKNOWN
            );
            let p = power_from_supplies(&[mouse, ac(true), bat("Charging", 90)]);
            assert_eq!(p.percent, Some(90));
            // A capacity above 100 is dropped.
            assert_eq!(
                power_from_supplies(&[bat("Discharging", 130)]).percent,
                None
            );
        }

        #[cfg(windows)]
        #[test]
        fn the_real_power_request_is_taken_once_and_released_once() {
            let mut wake = WakeLock::default();
            assert!(wake.supported());
            assert!(!wake.held());
            wake.request().expect("this Windows grants a power request");
            assert!(wake.held());
            let first = wake.0;
            wake.request().expect("a second request is a no-op");
            assert_eq!(wake.0, first, "no second handle");
            wake.release();
            assert!(!wake.held());
            wake.release();
            assert!(!wake.held());
            // Usable again after a release.
            wake.request().expect("request after release");
            assert!(wake.held());
            // Dropped while held: Drop releases.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::sys::{DiskStatus, PowerSource, PowerStatus};
    use super::*;

    /// Counts what the lock asks of the OS.
    #[derive(Default)]
    struct FakeWake {
        supported: bool,
        refuse: bool,
        held: bool,
        requests: u32,
        releases: u32,
    }

    impl FakeWake {
        fn ok() -> Self {
            Self {
                supported: true,
                ..Self::default()
            }
        }
    }

    impl Wake for FakeWake {
        fn supported(&self) -> bool {
            self.supported
        }
        fn request(&mut self) -> Result<(), WakeError> {
            self.requests += 1;
            if !self.supported {
                return Err(WakeError::Unsupported);
            }
            if self.refuse {
                return Err(WakeError::Failed("refused".into()));
            }
            self.held = true;
            Ok(())
        }
        fn release(&mut self) {
            if self.held {
                self.releases += 1;
            }
            self.held = false;
        }
        fn held(&self) -> bool {
            self.held
        }
    }

    #[test]
    fn locking_keeps_awake_and_unlocking_lets_go() {
        let mut g = Inner::new(FakeWake::ok());
        assert_eq!(
            g.status(),
            GigShell {
                locked: false,
                keep_awake: KeepAwake::Off
            }
        );
        assert_eq!(
            g.set_locked(true),
            GigShell {
                locked: true,
                keep_awake: KeepAwake::On
            }
        );
        assert!(g.wake.held);
        assert_eq!(
            g.set_locked(false),
            GigShell {
                locked: false,
                keep_awake: KeepAwake::Off
            }
        );
        assert!(!g.wake.held, "unlock must release keep-awake");
        assert_eq!((g.wake.requests, g.wake.releases), (1, 1));
    }

    #[test]
    fn two_locks_and_one_unlock_leave_nothing_held() {
        let mut g = Inner::new(FakeWake::ok());
        g.set_locked(true);
        g.set_locked(true);
        assert_eq!(g.wake.requests, 1, "a second lock asks for nothing more");
        g.set_locked(false);
        assert!(!g.wake.held);
        assert_eq!(g.wake.releases, 1);
        // Unlocking again is harmless.
        assert_eq!(g.set_locked(false).keep_awake, KeepAwake::Off);
        assert_eq!(g.wake.releases, 1);
    }

    #[test]
    fn a_system_without_keep_awake_says_so_locked_or_not() {
        let mut g = Inner::new(FakeWake::default());
        assert_eq!(g.status().keep_awake, KeepAwake::Unsupported);
        let s = g.set_locked(true);
        assert_eq!(
            s,
            GigShell {
                locked: true,
                keep_awake: KeepAwake::Unsupported
            }
        );
        assert_eq!(g.set_locked(false).keep_awake, KeepAwake::Unsupported);
    }

    #[test]
    fn a_refused_request_is_reported_and_tried_again_by_the_next_lock() {
        let mut g = Inner::new(FakeWake {
            refuse: true,
            ..FakeWake::ok()
        });
        let s = g.set_locked(true);
        assert_eq!(
            s,
            GigShell {
                locked: true,
                keep_awake: KeepAwake::Failed
            }
        );
        // The lock itself holds without keep-awake.
        assert!(g.locked);
        g.wake.refuse = false;
        assert_eq!(g.set_locked(true).keep_awake, KeepAwake::On);
        assert_eq!(g.wake.requests, 2);
    }

    #[test]
    fn the_status_serialises_in_the_form_the_ui_reads() {
        let json = serde_json::to_value(GigShell {
            locked: true,
            keep_awake: KeepAwake::Unsupported,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "locked": true, "keepAwake": "unsupported" })
        );
        for (state, text) in [
            (KeepAwake::On, "on"),
            (KeepAwake::Off, "off"),
            (KeepAwake::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), text);
        }
        let sys = GigSystemStatus {
            power: PowerStatus {
                source: PowerSource::Battery,
                percent: Some(42),
                charging: Some(false),
            },
            disk: DiskStatus {
                path: Some("C:\\sets".into()),
                free_bytes: Some(1),
                total_bytes: Some(2),
                network: false,
                error: None,
            },
        };
        assert_eq!(
            serde_json::to_value(sys).unwrap(),
            serde_json::json!({
                "power": { "source": "battery", "percent": 42, "charging": false },
                "disk": { "path": "C:\\sets", "freeBytes": 1, "totalBytes": 2, "network": false, "error": null },
            })
        );
    }

    #[test]
    fn an_unlocked_window_closes_without_a_question() {
        let mut ask = CloseAsk::default();
        let t = Instant::now();
        assert_eq!(on_close_request(false, &mut ask, t), CloseVerdict::Close);
        assert_eq!(ask, CloseAsk::default());
    }

    #[test]
    fn a_locked_window_asks_and_keeps_asking_while_the_page_answers() {
        let mut ask = CloseAsk::default();
        let t = Instant::now();
        assert_eq!(on_close_request(true, &mut ask, t), CloseVerdict::Ask);
        assert_eq!(ask.asked_at, Some(t));
        // The page put its question on screen.
        ask.seen = true;
        // Much later (the DJ chose "keep playing" and someone closes again): still asks, and
        // the new question waits for its own acknowledgement.
        let later = t + Duration::from_secs(600);
        assert_eq!(on_close_request(true, &mut ask, later), CloseVerdict::Ask);
        assert_eq!(
            ask,
            CloseAsk {
                asked_at: Some(later),
                seen: false
            }
        );
    }

    #[test]
    fn a_page_that_never_answers_cannot_trap_the_window() {
        let mut ask = CloseAsk::default();
        let t = Instant::now();
        assert_eq!(on_close_request(true, &mut ask, t), CloseVerdict::Ask);
        // Hammering close inside the patience: still held, and the clock is NOT restarted.
        let soon = t + CLOSE_PATIENCE / 2;
        assert_eq!(on_close_request(true, &mut ask, soon), CloseVerdict::Ask);
        assert_eq!(ask.asked_at, Some(t));
        let edge = t + CLOSE_PATIENCE - Duration::from_millis(1);
        assert_eq!(on_close_request(true, &mut ask, edge), CloseVerdict::Ask);
        // At the patience, unacknowledged: the window closes.
        assert_eq!(
            on_close_request(true, &mut ask, t + CLOSE_PATIENCE),
            CloseVerdict::Close
        );
        assert_eq!(ask, CloseAsk::default());
    }

    #[test]
    fn unlocking_drops_a_question_that_is_out() {
        let mut g = Inner::new(FakeWake::ok());
        g.set_locked(true);
        let t = Instant::now();
        assert_eq!(
            on_close_request(g.locked, &mut g.close, t),
            CloseVerdict::Ask
        );
        g.set_locked(false);
        assert_eq!(g.close, CloseAsk::default());
        assert_eq!(
            on_close_request(g.locked, &mut g.close, t + Duration::from_millis(10)),
            CloseVerdict::Close
        );
    }

    /// The Tauri glue cannot run in a unit test: pin its shape in the source instead.
    #[test]
    fn the_close_watch_is_on_the_main_window_and_prevents_only_when_asked() {
        // A Windows checkout may have CRLF line ends.
        let src = include_str!("gig.rs").replace("\r\n", "\n");
        let start = src.find("pub fn init(").expect("init");
        let end = src[start..].find("\n}\n").expect("end of init") + start;
        // Comments removed first: a call that is only mentioned in (or commented out into) a
        // comment is not a call.
        let body: String = src[start..end]
            .lines()
            .map(|l| l.find("//").map_or(l, |i| &l[..i]))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(body.contains("app.get_webview_window(MAIN_WINDOW)"));
        assert!(body.contains("tauri::WindowEvent::CloseRequested { api, .. }"));
        let decide = body.find("on_close_request(locked").expect("decides first");
        let prevent = body.find("api.prevent_close()").expect("prevents");
        let guard = body
            .find("if verdict == CloseVerdict::Ask {")
            .expect("guard");
        let emit = body
            .find("handle.emit_to(MAIN_WINDOW, CLOSE_EVENT, ())")
            .expect("emits");
        assert!(decide < guard && guard < prevent && prevent < emit);
        assert_eq!(MAIN_WINDOW, "main");
        assert_eq!(CLOSE_EVENT, "gig://close-request");
    }
}
