//! Native HID device support (`hidapi`).
//!
//! This is the FOUNDATION layer for HID-class DJ gear (Pioneer CDJs, many
//! all-in-one controllers, jog/screen devices) that don't speak MIDI. Unlike
//! the MIDI module — which already maps bytes → semantic actions — full HID
//! decoding is per-device (each CDJ model has its own report layout), so this
//! increment intentionally stops at the transport:
//!
//!   1. **Enumerate** connected HID devices (vendor/product id + names).
//!   2. **Connect** to one and stream its raw input reports to the UI as a
//!      `hid://input` event (hex + bytes), so mappings can be authored/learned.
//!   3. **Disconnect** (stops the reader thread).
//!
//! Per-device report decoders (jog ticks, platter touch, fader positions) build
//! ON TOP of this stream in later increments — same two-layer split as MIDI.
//!
//! A small built-in registry of well-known DJ HID vendor/product ids lets the
//! UI label and prioritise real gear among the noise of every HID device on the
//! machine (keyboards, mice, etc.).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

use hidapi::HidApi;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// A discovered HID device, as the UI lists it. `path` is the OS device path
/// used to open it unambiguously (two identical CDJs differ only by path).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidDeviceInfo {
    pub path: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    /// True when this matches a known DJ vendor/product (see `KNOWN_DJ_HID`).
    pub is_dj_gear: bool,
    /// Friendly label from our registry when `is_dj_gear`, else the product name.
    pub label: String,
}

/// A raw input report emitted to the UI as `hid://input`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidInputEvent {
    /// Bytes of the report (first byte is the report id on numbered devices).
    pub bytes: Vec<u8>,
    /// Hex string for convenient display / logging.
    pub hex: String,
}

/// Known DJ HID vendor/product ids → friendly name. Vendor 0x2b73 = Pioneer DJ.
/// Product ids here are representative; unknown Pioneer products still flag as
/// DJ gear via the vendor-only fallback in `label_for`.
const KNOWN_DJ_HID: &[(u16, u16, &str)] = &[
    (0x2b73, 0x0017, "Pioneer DDJ-SX"),
    (0x2b73, 0x0029, "Pioneer DDJ-1000"),
    (0x2b73, 0x003c, "Pioneer DDJ-FLX4"),
    (0x08e4, 0x017f, "Pioneer CDJ-2000NXS2"),
    (0x08e4, 0x0188, "Pioneer CDJ-3000"),
];

/// Vendor ids that are DJ manufacturers (used for a vendor-only fallback so new
/// products from a known vendor still surface as gear).
const DJ_VENDORS: &[(u16, &str)] = &[
    (0x2b73, "Pioneer DJ"),
    (0x08e4, "Pioneer"),
    (0x17cc, "Native Instruments"),
    (0x15e4, "Numark"),
    (0x06f8, "Hercules"),
];

fn label_for(vendor: u16, product: u16, product_name: &Option<String>) -> (bool, String) {
    if let Some((_, _, name)) = KNOWN_DJ_HID.iter().find(|(v, p, _)| *v == vendor && *p == product) {
        return (true, (*name).to_string());
    }
    if let Some((_, vname)) = DJ_VENDORS.iter().find(|(v, _)| *v == vendor) {
        let label = match product_name {
            Some(n) if !n.is_empty() => format!("{vname} — {n}"),
            _ => format!("{vname} (0x{product:04x})"),
        };
        return (true, label);
    }
    let label = product_name
        .clone()
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| format!("HID 0x{vendor:04x}:0x{product:04x}"));
    (false, label)
}

/// Tauri-managed HID state: the open device + a flag the reader thread polls to
/// know when to stop. The `HidApi` handle is created per-operation (cheap) to
/// avoid holding a global lock across the whole app lifetime.
#[derive(Default)]
pub struct HidState {
    inner: Mutex<HidInner>,
}

#[derive(Default)]
struct HidInner {
    /// Set false to ask the reader thread to exit.
    running: Option<Arc<AtomicBool>>,
    /// The path of the currently-open device (for status display).
    open_path: Option<String>,
    /// Send raw output reports to the reader thread, which owns the device and
    /// performs the write between reads (single-thread ownership — `HidDevice`
    /// is `Send` but not `Sync`, so we never share it across threads).
    tx: Option<Sender<Vec<u8>>>,
}

impl HidState {
    pub fn new() -> Self {
        HidState::default()
    }
}

/// Enumerate all HID devices, DJ gear first.
pub fn list_devices() -> Result<Vec<HidDeviceInfo>, String> {
    let api = HidApi::new().map_err(|e| e.to_string())?;
    let mut out: Vec<HidDeviceInfo> = api
        .device_list()
        .map(|d| {
            let product = d.product_string().map(|s| s.to_string());
            let manufacturer = d.manufacturer_string().map(|s| s.to_string());
            let (is_dj_gear, label) = label_for(d.vendor_id(), d.product_id(), &product);
            HidDeviceInfo {
                path: d.path().to_string_lossy().to_string(),
                vendor_id: d.vendor_id(),
                product_id: d.product_id(),
                manufacturer,
                product,
                is_dj_gear,
                label,
            }
        })
        .collect();
    // De-dupe by path (some platforms list interface duplicates).
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    // DJ gear bubbles to the top, then by label.
    out.sort_by(|a, b| b.is_dj_gear.cmp(&a.is_dj_gear).then_with(|| a.label.cmp(&b.label)));
    Ok(out)
}

/// Open the device at `path` and stream its input reports to the UI as
/// `hid://input`. Replaces any existing connection. Returns the device label.
pub fn connect(app: AppHandle, hid: &HidState, path: &str) -> Result<String, String> {
    // Tear down any existing reader first.
    disconnect(hid);

    let api = HidApi::new().map_err(|e| e.to_string())?;
    let cpath = std::ffi::CString::new(path).map_err(|_| "invalid device path".to_string())?;
    let device = api.open_path(&cpath).map_err(|e| e.to_string())?;

    // Best-effort label for the return value + status.
    let (_, label) = {
        let info = api
            .device_list()
            .find(|d| d.path().to_string_lossy() == path);
        match info {
            Some(d) => label_for(d.vendor_id(), d.product_id(), &d.product_string().map(|s| s.to_string())),
            None => (false, path.to_string()),
        }
    };

    // Non-blocking reads so the thread can poll the stop flag promptly.
    let _ = device.set_blocking_mode(false);

    let running = Arc::new(AtomicBool::new(true));
    let stop = running.clone();
    let app_cb = app.clone();
    let (tx, rx): (Sender<Vec<u8>>, Receiver<Vec<u8>>) = mpsc::channel();

    thread::spawn(move || {
        let mut buf = [0u8; 256];
        while stop.load(Ordering::Relaxed) {
            // Flush any pending output reports (LED/feedback) first.
            while let Ok(out) = rx.try_recv() {
                let _ = device.write(&out);
            }
            match device.read_timeout(&mut buf, 20) {
                Ok(0) => {
                    // No report ready; yield briefly.
                    thread::sleep(Duration::from_millis(2));
                }
                Ok(n) => {
                    let bytes = buf[..n].to_vec();
                    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
                    let _ = app_cb.emit("hid://input", HidInputEvent { bytes, hex });
                }
                Err(_) => {
                    // Device unplugged or read error — stop the loop.
                    break;
                }
            }
        }
    });

    let mut guard = hid.inner.lock().unwrap();
    guard.running = Some(running);
    guard.open_path = Some(path.to_string());
    guard.tx = Some(tx);
    Ok(label)
}

/// Stop the reader thread and drop the open device.
pub fn disconnect(hid: &HidState) {
    let mut guard = hid.inner.lock().unwrap();
    if let Some(running) = guard.running.take() {
        running.store(false, Ordering::Relaxed);
    }
    guard.open_path = None;
    guard.tx = None;
}

/// The path of the currently-open HID device, or None.
pub fn open_path(hid: &HidState) -> Option<String> {
    hid.inner.lock().unwrap().open_path.clone()
}

/// Queue a raw output report (LED/feedback) for the connected device. The
/// reader thread performs the actual write. First byte is the report id on
/// numbered devices (use 0 for unnumbered reports).
pub fn write_report(hid: &HidState, bytes: Vec<u8>) -> Result<(), String> {
    let guard = hid.inner.lock().unwrap();
    let tx = guard.tx.as_ref().ok_or("no HID device connected")?;
    tx.send(bytes).map_err(|_| "HID writer unavailable".to_string())
}
