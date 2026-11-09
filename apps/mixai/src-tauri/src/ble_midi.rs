//! Direct Bluetooth LE MIDI for MixAI Decks (any BLE-MIDI 1.0 controller, e.g. Pioneer DDJ-FLX4).
//!
//! Works without OS-level BLE MIDI support and without pairing: we act as the GATT central,
//! subscribe to the MIDI I/O characteristic and feed decoded messages into the same dispatcher
//! as USB MIDI (shared preset + learn). Also:
//!   * LED feedback: deck play/cue state is written back (write-without-response);
//!   * auto-connect: the last device is remembered and reconnected whenever it advertises;
//!   * link stats (messages/s, packet gap, RSSI) are emitted as `ble-midi://stats`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use btleplug::api::{
    Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager as _};
use uuid::Uuid;

use crate::EngineState;
use crate::ble_midi_packet::{Decoder, encode};
use crate::midi::{Dispatcher, MidiState};

pub const MIDI_SERVICE: Uuid = Uuid::from_u128(0x03b80e5a_ede8_4b33_a751_6ce34ec4c700);
pub const MIDI_IO_CHAR: Uuid = Uuid::from_u128(0x7772e5db_3868_4112_a1a9_f2669d106bf3);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BleMidiDevice {
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BleMidiStats {
    pub name: String,
    pub connected: bool,
    pub msgs_per_sec: f32,
    pub packets_per_sec: f32,
    pub gap_p95_ms: f32,
    pub rssi: Option<i16>,
    pub reconnects: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Saved {
    name: Option<String>,
    auto_connect: bool,
}

#[derive(Default)]
pub struct BleMidiState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    adapter: Option<Adapter>,
    /// Session token: bumped on every connect/disconnect so old tasks stop.
    session: u64,
    connected: Option<(String, Peripheral, Characteristic)>,
    saved: Saved,
    reconnects: u32,
}

impl BleMidiState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn saved_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("ble-midi.json"))
}

fn load_saved(app: &AppHandle) -> Saved {
    saved_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn store_saved(app: &AppHandle, s: &Saved) {
    if let Some(p) = saved_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
    }
}

async fn adapter(state: &BleMidiState) -> Result<Adapter, String> {
    if let Some(a) = state.inner.lock().unwrap().adapter.clone() {
        return Ok(a);
    }
    let manager = Manager::new().await.map_err(|e| e.to_string())?;
    let a = manager
        .adapters()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| "no Bluetooth adapter".to_string())?;
    state.inner.lock().unwrap().adapter = Some(a.clone());
    Ok(a)
}

async fn describe(p: &Peripheral) -> Option<(String, Option<i16>, bool)> {
    let props = p.properties().await.ok().flatten()?;
    let is_midi = props.services.contains(&MIDI_SERVICE);
    let name = props.local_name?;
    Some((name, props.rssi, is_midi))
}

/// Scan for `secs` and return devices advertising the BLE-MIDI service.
pub async fn scan(app: &AppHandle, secs: u64) -> Result<Vec<BleMidiDevice>, String> {
    let state = app.state::<BleMidiState>();
    let a = adapter(&state).await?;
    a.start_scan(ScanFilter {
        services: vec![MIDI_SERVICE],
    })
    .await
    .map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_secs(secs.clamp(1, 15))).await;
    let connected = state
        .inner
        .lock()
        .unwrap()
        .connected
        .as_ref()
        .map(|c| c.0.clone());
    let mut best: HashMap<String, BleMidiDevice> = HashMap::new();
    for p in a.peripherals().await.map_err(|e| e.to_string())? {
        let Some((name, rssi, is_midi)) = describe(&p).await else {
            continue;
        };
        let is_connected = connected.as_deref() == Some(name.as_str());
        if !(is_midi || is_connected) || best.get(&name).is_some_and(|d| d.rssi >= rssi) {
            continue;
        }
        best.insert(
            name.clone(),
            BleMidiDevice {
                id: p.id().to_string(),
                connected: is_connected,
                name,
                rssi,
            },
        );
    }
    let mut out: Vec<BleMidiDevice> = best.into_values().collect();
    out.sort_by_key(|d| std::cmp::Reverse(d.rssi));
    Ok(out)
}

async fn find_by_name(a: &Adapter, name: &str, wait: Duration) -> Option<Peripheral> {
    let _ = a
        .start_scan(ScanFilter {
            services: vec![MIDI_SERVICE],
        })
        .await;
    let deadline = Instant::now() + wait;
    loop {
        if let Ok(ps) = a.peripherals().await {
            for p in ps {
                if describe(&p).await.is_some_and(|(n, _, _)| n == name) {
                    return Some(p);
                }
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// Connect to the named device, subscribe and start dispatching. Remembers it for auto-connect.
pub async fn connect(app: AppHandle, name: String) -> Result<String, String> {
    let state = app.state::<BleMidiState>();
    let a = adapter(&state).await?;
    let p = find_by_name(&a, &name, Duration::from_secs(8))
        .await
        .ok_or_else(|| {
            format!("'{name}' is not advertising (switch it on / disconnect it from other hosts)")
        })?;
    p.connect().await.map_err(|e| e.to_string())?;
    p.discover_services().await.map_err(|e| e.to_string())?;
    let ch = p
        .characteristics()
        .into_iter()
        .find(|c| c.uuid == MIDI_IO_CHAR && c.properties.contains(CharPropFlags::NOTIFY))
        .ok_or("device has no BLE-MIDI characteristic")?;
    p.subscribe(&ch).await.map_err(|e| e.to_string())?;
    let _ = a.stop_scan().await;

    let session = {
        let mut g = state.inner.lock().unwrap();
        g.session += 1;
        g.connected = Some((name.clone(), p.clone(), ch.clone()));
        g.saved = Saved {
            name: Some(name.clone()),
            auto_connect: true,
        };
        store_saved(&app, &g.saved);
        g.session
    };

    let dispatcher = Dispatcher::new(app.clone(), &app.state::<MidiState>());
    let stats = Arc::new(Mutex::new(StatsWindow::default()));
    spawn_reader(app.clone(), p.clone(), dispatcher, stats.clone(), session);
    spawn_feedback(app.clone(), p.clone(), ch, session);
    spawn_stats(app.clone(), p.clone(), name.clone(), stats, session);
    log::info!("BLE MIDI connected: {name}");
    Ok(name)
}

pub async fn disconnect(app: &AppHandle, forget: bool) {
    let state = app.state::<BleMidiState>();
    let p = {
        let mut g = state.inner.lock().unwrap();
        g.session += 1;
        if forget {
            g.saved.auto_connect = false;
            store_saved(app, &g.saved);
        }
        g.connected.take().map(|c| c.1)
    };
    if let Some(p) = p {
        let _ = p.disconnect().await;
    }
}

fn current(app: &AppHandle, session: u64) -> bool {
    app.state::<BleMidiState>().inner.lock().unwrap().session == session
}

#[derive(Default)]
struct StatsWindow {
    msgs: u32,
    packets: u32,
    last: Option<Instant>,
    gaps_ms: Vec<f32>,
}

fn spawn_reader(
    app: AppHandle,
    p: Peripheral,
    dispatcher: Dispatcher,
    stats: Arc<Mutex<StatsWindow>>,
    session: u64,
) {
    tauri::async_runtime::spawn(async move {
        let Ok(mut stream) = p.notifications().await else {
            return;
        };
        let mut dec = Decoder::new();
        while let Some(n) = stream.next().await {
            if !current(&app, session) {
                return;
            }
            if n.uuid != MIDI_IO_CHAR {
                continue;
            }
            let mut count = 0;
            dec.decode(&n.value, |m| {
                count += 1;
                dispatcher.dispatch(m);
            });
            let mut s = stats.lock().unwrap();
            let now = Instant::now();
            if let Some(l) = s.last {
                s.gaps_ms.push(now.duration_since(l).as_secs_f32() * 1000.0);
            }
            s.last = Some(now);
            s.packets += 1;
            s.msgs += count;
        }
        // Stream ended = link lost; the stats/watchdog task handles reconnection.
    });
}

/// LED feedback for the DDJ-FLX4 layout (PLAY 0x0B / CUE 0x0C on ch1/ch2). Generic controllers
/// ignore notes they do not map.
fn spawn_feedback(app: AppHandle, p: Peripheral, ch: Characteristic, session: u64) {
    if !ch
        .properties
        .contains(CharPropFlags::WRITE_WITHOUT_RESPONSE)
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut last: HashMap<(u8, u8), u8> = HashMap::new();
        let t0 = Instant::now();
        while current(&app, session) {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let snap = {
                let st = app.state::<EngineState>();
                let g = st.0.lock().unwrap();
                g.as_ref().map(|e| e.snapshot_state())
            };
            let Some(s) = snap else { continue };
            let mut msgs: Vec<[u8; 3]> = Vec::new();
            for (i, d) in s.decks.iter().take(2).enumerate() {
                let st = 0x90 | i as u8;
                for (note, on) in [(0x0Bu8, d.playing), (0x0Cu8, d.loaded && !d.playing)] {
                    let v = if on { 0x7F } else { 0x00 };
                    if last.insert((st, note), v) != Some(v) {
                        msgs.push([st, note, v]);
                    }
                }
            }
            if msgs.is_empty() {
                continue;
            }
            let refs: Vec<&[u8]> = msgs.iter().map(|m| m.as_slice()).collect();
            let ts = (t0.elapsed().as_millis() & 0x1FFF) as u16;
            for pkt in encode(&refs, ts, 20) {
                if p.write(&ch, &pkt, WriteType::WithoutResponse)
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    });
}

fn spawn_stats(
    app: AppHandle,
    p: Peripheral,
    name: String,
    stats: Arc<Mutex<StatsWindow>>,
    session: u64,
) {
    tauri::async_runtime::spawn(async move {
        while current(&app, session) {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let connected = p.is_connected().await.unwrap_or(false);
            let rssi = p.properties().await.ok().flatten().and_then(|x| x.rssi);
            let (msgs, packets, p95) = {
                let mut s = stats.lock().unwrap();
                let mut g = std::mem::take(&mut s.gaps_ms);
                g.sort_by(|a, b| a.total_cmp(b));
                let p95 = if g.is_empty() {
                    0.0
                } else {
                    g[(g.len() * 95 / 100).min(g.len() - 1)]
                };
                let r = (s.msgs, s.packets, p95);
                s.msgs = 0;
                s.packets = 0;
                r
            };
            let reconnects = app.state::<BleMidiState>().inner.lock().unwrap().reconnects;
            let _ = app.emit(
                "ble-midi://stats",
                BleMidiStats {
                    name: name.clone(),
                    connected,
                    msgs_per_sec: msgs as f32,
                    packets_per_sec: packets as f32,
                    gap_p95_ms: p95,
                    rssi,
                    reconnects,
                },
            );
            if !connected {
                // Link dropped (console off / out of range): hand over to auto-connect.
                {
                    let st = app.state::<BleMidiState>();
                    let mut g = st.inner.lock().unwrap();
                    if g.session != session {
                        return;
                    }
                    g.session += 1;
                    g.connected = None;
                    g.reconnects += 1;
                }
                start_auto_connect(app.clone());
                return;
            }
        }
    });
}

/// Keep trying the remembered device until it connects or auto-connect is turned off.
pub fn start_auto_connect(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let saved = {
            let st = app.state::<BleMidiState>();
            let mut g = st.inner.lock().unwrap();
            if g.saved.name.is_none() {
                g.saved = load_saved(&app);
            }
            g.saved.clone()
        };
        let Some(name) = saved.name.filter(|_| saved.auto_connect) else {
            return;
        };
        let start_session = app.state::<BleMidiState>().inner.lock().unwrap().session;
        loop {
            {
                let st = app.state::<BleMidiState>();
                let g = st.inner.lock().unwrap();
                if g.connected.is_some() || g.session != start_session || !g.saved.auto_connect {
                    return;
                }
            }
            match connect(app.clone(), name.clone()).await {
                Ok(_) => {
                    let _ = app.emit("ble-midi://connected", name.clone());
                    return;
                }
                Err(e) => log::debug!("BLE MIDI auto-connect '{name}': {e}"),
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

pub fn status(app: &AppHandle) -> (Option<String>, bool) {
    let st = app.state::<BleMidiState>();
    let mut g = st.inner.lock().unwrap();
    if g.saved.name.is_none() {
        g.saved = load_saved(app);
    }
    (
        g.connected
            .as_ref()
            .map(|c| c.0.clone())
            .or(g.saved.name.clone()),
        g.connected.is_some(),
    )
}
