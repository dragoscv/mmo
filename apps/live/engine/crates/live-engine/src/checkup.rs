//! System checkup: things outside the engine that add delay or make low buffers unstable.
//! Read-only. The ids and values are a contract with the desktop app (which owns the texts in
//! RO/EN); `detail` is an English line for the command line only.
//!
//! Every status decision is a pure function (tested on every platform). The Windows reads live in
//! [`win`]: `IAudioEndpointVolume` (volume / mute), `IAudioClient::IsFormatSupported` in exclusive
//! mode (opens no stream), `GetMixFormat` (the shared-mode rate), the endpoint property store
//! (`PKEY_AudioEndpoint_Disable_SysFx`, form factor, enumerator name) with the endpoint's
//! `FxProperties` registry key as the fallback for the effects switch, `PowerGetActiveScheme`
//! and the read-only Voicemeeter picture. Nothing is opened, started or written.

use crate::io::{self, IoConfig};
use crate::voicemeeter::VoicemeeterInfo;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Warn,
    Fail,
    /// Could not be read on this system.
    Unknown,
}

/// One finding. Ids (stable): `exclusive_allowed`, `enhancements`, `sample_rate`,
/// `endpoint_volume`, `output_kind`, `power_plan`, `voicemeeter_owns_device`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CheckItem {
    pub id: String,
    pub status: Status,
    /// `"input"` / `"output"` for per-device items, `None` for machine-wide ones.
    pub device: Option<String>,
    /// Machine-readable value, per id (see `docs/live/cli.md`).
    pub value: Option<String>,
    pub detail: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Checkup {
    pub items: Vec<CheckItem>,
}

/// Windows volume of one endpoint (the slider in the sound settings), as the driver reports it.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct EndpointLevel {
    /// 0..1, the slider position.
    pub volume: f32,
    /// The same in dB (0 = full).
    pub volume_db: f32,
    pub muted: bool,
}

/// Volume and mute of a device (name or id as in `devices`); `None` = system default of that
/// direction. Returns `None` when it cannot be read (other systems, unknown device).
pub fn endpoint_level(device: Option<&str>, input: bool) -> Option<EndpointLevel> {
    #[cfg(windows)]
    {
        win::endpoint_level(device, input)
    }
    #[cfg(not(windows))]
    {
        let _ = (device, input);
        None
    }
}

/// Inspect the devices named in `cfg` and the machine. Opens no stream and changes nothing.
/// The Voicemeeter insert host and the simulated host have no Windows endpoints: only the
/// machine-wide items come back. On other systems the list is empty.
pub fn run(cfg: &IoConfig) -> Checkup {
    #[allow(unused_mut)]
    let mut items: Vec<CheckItem> = Vec::new();
    #[cfg(windows)]
    {
        let host = cfg.host.as_deref();
        let no_endpoints = host.is_some_and(|h| {
            h.eq_ignore_ascii_case(io::NULL_HOST) || h.eq_ignore_ascii_case(io::VOICEMEETER_INSERT)
        });
        let mut names: [Option<String>; 2] = [None, None];
        if !no_endpoints {
            for (input, dev) in [(true, cfg.input.as_deref()), (false, cfg.output.as_deref())] {
                // Resolved through cpal first: it initialises COM on this thread its own way, and
                // the same thread opens the streams later.
                match io::wasapi_endpoint(dev, input) {
                    Ok((id, name)) => {
                        win::inspect(&id, &name, input, cfg, &mut items);
                        names[usize::from(!input)] = Some(name);
                    }
                    Err(e) => items.extend(unknown_items(input, &e.to_string())),
                }
            }
        }
        items.push(power_plan_item(win::active_power_scheme()));
        let vm = crate::voicemeeter::info();
        if let Some(it) = voicemeeter_ownership(&vm, names[0].as_deref(), names[1].as_deref(), host)
        {
            items.push(it);
        }
    }
    #[cfg(not(windows))]
    let _ = cfg;
    Checkup { items }
}

/// Ids of every item [`run`] can produce.
pub static ITEM_IDS: [&str; 7] = [
    "endpoint_volume",
    "exclusive_allowed",
    "enhancements",
    "sample_rate",
    "output_kind",
    "power_plan",
    "voicemeeter_owns_device",
];

/// Below this Windows volume (dB, 0 = slider at full) the output is quiet enough to be mistaken
/// for a broken route.
pub const LOW_VOLUME_DB: f32 = -20.0;

// HRESULTs as raw values, so the decision is testable on every platform.
pub const HR_S_OK: i32 = 0;
pub const HR_S_FALSE: i32 = 1;
pub const HR_UNSUPPORTED_FORMAT: i32 = 0x8889_0008_u32 as i32;
pub const HR_DEVICE_IN_USE: i32 = 0x8889_000A_u32 as i32;
pub const HR_EXCLUSIVE_MODE_NOT_ALLOWED: i32 = 0x8889_000E_u32 as i32;
pub const HR_DEVICE_INVALIDATED: i32 = 0x8889_0004_u32 as i32;

fn item(
    id: &str,
    status: Status,
    device: Option<&str>,
    value: Option<String>,
    detail: String,
) -> CheckItem {
    CheckItem {
        id: id.to_owned(),
        status,
        device: device.map(str::to_owned),
        value,
        detail,
    }
}

/// Per-device ids of one direction (the output has one more).
#[cfg(windows)]
fn device_ids(input: bool) -> &'static [&'static str] {
    if input {
        &ITEM_IDS[..4]
    } else {
        &ITEM_IDS[..5]
    }
}

/// Every per-device item as `unknown` with the same reason (device not resolved, no COM).
#[cfg(windows)]
fn unknown_items(input: bool, reason: &str) -> Vec<CheckItem> {
    let which = if input { "input" } else { "output" };
    device_ids(input)
        .iter()
        .map(|id| {
            item(
                id,
                Status::Unknown,
                Some(which),
                None,
                format!("The {which} could not be inspected: {reason}."),
            )
        })
        .collect()
}

/// `endpoint_volume`: muted is a failure, a slider far down is a warning.
pub fn volume_status(level: &EndpointLevel) -> (Status, String) {
    if level.muted {
        return (Status::Fail, "muted".into());
    }
    let db = if level.volume_db.abs() < 0.05 {
        0.0
    } else {
        level.volume_db
    };
    let status = if db < LOW_VOLUME_DB {
        Status::Warn
    } else {
        Status::Ok
    };
    (status, format!("{db:.1}"))
}

/// `exclusive_allowed` from the HRESULT `IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, ..)`
/// answered: a verdict about the format (supported or not) means exclusive mode itself is
/// allowed; anything else is reported as the code says.
pub fn exclusive_status(hr: i32) -> (Status, Option<&'static str>) {
    match hr {
        HR_EXCLUSIVE_MODE_NOT_ALLOWED => (Status::Fail, Some("disabled")),
        HR_DEVICE_IN_USE => (Status::Warn, Some("in_use")),
        HR_S_OK | HR_S_FALSE | HR_UNSUPPORTED_FORMAT => (Status::Ok, Some("allowed")),
        _ => (Status::Unknown, None),
    }
}

/// What the exclusive-mode answer means, for the command line.
pub fn exclusive_answer_text(hr: i32) -> &'static str {
    match hr {
        HR_EXCLUSIVE_MODE_NOT_ALLOWED => "exclusive mode is disabled for this device",
        HR_DEVICE_IN_USE => "another application holds the device right now",
        HR_S_OK => "the format is supported",
        HR_S_FALSE => "a closest match was offered",
        HR_UNSUPPORTED_FORMAT => "no format matched, which is still an answer about formats",
        HR_DEVICE_INVALIDATED => "the device was removed or reconfigured",
        _ => "an answer this checkup does not know",
    }
}

/// `enhancements`: `switch` is `PKEY_AudioEndpoint_Disable_SysFx` (0 = `ENDPOINT_SYSFX_ENABLED`,
/// 1 = `ENDPOINT_SYSFX_DISABLED`, `None` = not stored); `effects_registered` = the endpoint has
/// effect classes (`PKEY_FX_*EffectClsid`) registered. Without a stored switch Windows loads the
/// registered effects, so that case is "on"; no switch and nothing registered is "off".
pub fn enhancements_status(
    switch: Option<u32>,
    effects_registered: bool,
) -> (Status, &'static str) {
    match switch {
        Some(0) => (Status::Warn, "on"),
        Some(_) => (Status::Ok, "off"),
        None if effects_registered => (Status::Warn, "on"),
        None => (Status::Ok, "off"),
    }
}

/// `sample_rate`: the device's shared-mode mix rate against the engine's rate.
pub fn sample_rate_status(device_rate: u32, wanted: u32) -> Status {
    if device_rate == wanted {
        Status::Ok
    } else {
        Status::Warn
    }
}

/// `EndpointFormFactor::DigitalAudioDisplayDevice` (HDMI / DisplayPort audio).
pub const FORM_FACTOR_DIGITAL_DISPLAY: u32 = 9;

/// `output_kind` from what the endpoint exposes: its name, `PKEY_Device_EnumeratorName`
/// (`BTHENUM`, `BTHHFENUM`, `USB`, `HDAUDIO`, `ROOT`, ...) and `PKEY_AudioEndpoint_FormFactor`.
pub fn output_kind(name: &str, enumerator: &str, form_factor: Option<u32>) -> &'static str {
    let n = name.to_ascii_lowercase();
    let e = enumerator.trim().to_ascii_uppercase();
    if io::classify(name).0 {
        return "virtual";
    }
    if e.starts_with("BTH") {
        return "bluetooth";
    }
    if e == "ROOT" || e == "SWD" {
        return "virtual";
    }
    if form_factor == Some(FORM_FACTOR_DIGITAL_DISPLAY)
        || n.contains("hdmi")
        || n.contains("displayport")
    {
        return "hdmi";
    }
    if e == "USB" {
        return "usb";
    }
    if matches!(e.as_str(), "HDAUDIO" | "INTELAUDIO" | "ACPI" | "PCI") {
        return "onboard";
    }
    "other"
}

pub fn output_kind_status(kind: &str) -> Status {
    if kind == "bluetooth" || kind == "hdmi" {
        Status::Warn
    } else {
        Status::Ok
    }
}

/// `power_plan` from the active scheme GUID (`xxxxxxxx-xxxx-...`, braces and case ignored):
/// the four schemes Windows ships; anything else keeps the GUID as the value.
pub fn power_plan(guid: &str) -> (Status, String) {
    let g = guid
        .trim()
        .trim_matches(|c| c == '{' || c == '}')
        .to_ascii_lowercase();
    let (status, value) = match g.as_str() {
        "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c" => (Status::Ok, "high_performance"),
        "e9a42b02-d5df-448d-aa00-03f14749eb61" => (Status::Ok, "ultimate"),
        "381b4222-f694-41f0-9685-ff5bb260df2e" => (Status::Warn, "balanced"),
        "a1841308-3541-4fab-bc81-f71556f20b4a" => (Status::Fail, "power_saver"),
        _ => return (Status::Unknown, g),
    };
    (status, value.to_owned())
}

#[cfg(windows)]
fn power_plan_item(guid: Option<String>) -> CheckItem {
    match guid {
        Some(g) => {
            let (status, value) = power_plan(&g);
            let detail = if status == Status::Unknown {
                format!(
                    "The active Windows power scheme is {value}, not one of the four schemes Windows ships."
                )
            } else {
                format!("The active Windows power scheme is {value} ({g}).")
            };
            item("power_plan", status, None, Some(value), detail)
        }
        None => item(
            "power_plan",
            Status::Unknown,
            None,
            None,
            "PowerGetActiveScheme did not return a scheme.".into(),
        ),
    }
}

/// Device names the way Voicemeeter and Windows report them: case-insensitive, and the longer
/// one must contain the shorter one (Voicemeeter may show a shortened name).
pub fn names_match(a: &str, b: &str) -> bool {
    let a = a.trim().to_ascii_lowercase();
    let b = b.trim().to_ascii_lowercase();
    if a.len() < 3 || b.len() < 3 {
        return false;
    }
    if a.len() >= b.len() {
        a.contains(&b)
    } else {
        b.contains(&a)
    }
}

/// `voicemeeter_owns_device`: Voicemeeter runs and has the input or the output on bus A1 or on a
/// hardware strip. A warning with the exclusive host (it fails with "device in use"), information
/// otherwise; `None` when Voicemeeter does not run or holds neither device. Names are the display
/// names of the resolved devices.
pub fn voicemeeter_ownership(
    info: &VoicemeeterInfo,
    input: Option<&str>,
    output: Option<&str>,
    host: Option<&str>,
) -> Option<CheckItem> {
    if !info.running {
        return None;
    }
    let exclusive = host.is_some_and(|h| h.eq_ignore_ascii_case(io::WASAPI_EXCLUSIVE));
    let mut holds: Vec<(String, String)> = Vec::new();
    if let (Some(a1), Some(out)) = (info.a1_device.as_deref(), output)
        && names_match(a1, out)
    {
        holds.push(("a1".into(), format!("bus A1 uses the output ({a1})")));
    }
    for s in &info.strips {
        if s.device.trim().is_empty() {
            continue;
        }
        let used: Vec<&str> = [("input", input), ("output", output)]
            .into_iter()
            .filter_map(|(what, name)| name.filter(|n| names_match(&s.device, n)).map(|_| what))
            .collect();
        if !used.is_empty() {
            let label = if s.label.trim().is_empty() {
                "unlabelled".to_owned()
            } else {
                format!("\"{}\"", s.label)
            };
            holds.push((
                format!("strip:{}", s.index),
                format!(
                    "hardware strip {} ({label}) uses the {} ({})",
                    s.index,
                    used.join(" and "),
                    s.device
                ),
            ));
        }
    }
    let (value, _) = holds.first()?;
    let what: Vec<&str> = holds.iter().map(|h| h.1.as_str()).collect();
    let what = what.join("; ");
    let (status, tail) = if exclusive {
        (
            Status::Warn,
            "the exclusive host cannot open a device Voicemeeter holds",
        )
    } else {
        (Status::Ok, "shared hosts can still open it")
    };
    Some(item(
        "voicemeeter_owns_device",
        status,
        None,
        Some(value.clone()),
        format!("Voicemeeter {what}; {tail}."),
    ))
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_EnumeratorName;
    use windows::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HLOCAL, LocalFree, PROPERTYKEY,
    };
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        self, IAudioClient, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
        PKEY_AudioEndpoint_Disable_SysFx, PKEY_AudioEndpoint_FormFactor, WAVEFORMATEX,
        WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
    };
    use windows::Win32::Media::KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM;
    use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantClear};
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        CoUninitialize, STGM_READ,
    };
    use windows::Win32::System::Power::PowerGetActiveScheme;
    use windows::Win32::System::Registry::{
        HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD, REG_VALUE_TYPE, RegCloseKey, RegOpenKeyExW,
        RegQueryValueExW,
    };
    use windows::Win32::System::Variant::{VT_EMPTY, VT_LPWSTR, VT_UI4};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::core::{GUID, HSTRING};

    /// COM on the calling thread, balanced on drop when the initialisation was ours. A thread
    /// cpal already made STA answers `RPC_E_CHANGED_MODE`: COM stays usable and is not ours to
    /// close. Declare it before every COM object of the function, so they are released first.
    struct Com(bool);

    impl Com {
        fn init() -> Com {
            // SAFETY: plain COM initialisation; CoUninitialize is called once in Drop iff this
            // call succeeded.
            Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                // SAFETY: balances the successful CoInitializeEx of `init` on this thread.
                unsafe { CoUninitialize() };
            }
        }
    }

    fn enumerator() -> Option<IMMDeviceEnumerator> {
        // SAFETY: COM is initialised on this thread (the caller holds a `Com`).
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }.ok()
    }

    fn device(en: &IMMDeviceEnumerator, id: &str) -> Option<IMMDevice> {
        // SAFETY: COM call with a valid, NUL-terminated wide string.
        unsafe { en.GetDevice(&HSTRING::from(id)) }.ok()
    }

    fn read_level(dev: &IMMDevice) -> Option<EndpointLevel> {
        // SAFETY: COM calls on a live device; only getters of the volume interface are used.
        unsafe {
            let vol = dev
                .Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                .ok()?;
            Some(EndpointLevel {
                volume: vol.GetMasterVolumeLevelScalar().ok()?,
                volume_db: vol.GetMasterVolumeLevel().ok()?,
                muted: vol.GetMute().ok()?.as_bool(),
            })
        }
    }

    pub(super) fn endpoint_level(device_name: Option<&str>, input: bool) -> Option<EndpointLevel> {
        let (id, _) = io::wasapi_endpoint(device_name, input).ok()?;
        let _com = Com::init();
        let en = enumerator()?;
        let dev = device(&en, &id)?;
        read_level(&dev)
    }

    struct Mix {
        ch: u16,
        rate: u32,
        mask: u32,
    }

    /// # Safety
    /// `p` must point at a WAVEFORMATEX returned by `GetMixFormat` (with its `cbSize` bytes).
    unsafe fn read_mix(p: *const WAVEFORMATEX) -> Mix {
        // SAFETY: caller contract; packed fields are read by value.
        unsafe {
            let f = *p;
            let (tag, ch, rate, cb) = (f.wFormatTag, f.nChannels, f.nSamplesPerSec, f.cbSize);
            let mask = if tag == 0xFFFE && cb >= 22 {
                let e = *(p as *const WAVEFORMATEXTENSIBLE);
                e.dwChannelMask
            } else {
                match ch {
                    1 => 0x4,
                    2 => 0x3,
                    _ => 0,
                }
            };
            Mix { ch, rate, mask }
        }
    }

    fn wfx(float: bool, bits: u16, ch: u16, rate: u32, mask: u32) -> WAVEFORMATEXTENSIBLE {
        let bytes = bits / 8;
        WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: 0xFFFE,
                nChannels: ch,
                nSamplesPerSec: rate,
                nAvgBytesPerSec: rate * u32::from(ch) * u32::from(bytes),
                nBlockAlign: ch * bytes,
                wBitsPerSample: bits,
                cbSize: 22,
            },
            Samples: WAVEFORMATEXTENSIBLE_0 {
                wValidBitsPerSample: bits,
            },
            dwChannelMask: mask,
            SubFormat: if float {
                KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
            } else {
                KSDATAFORMAT_SUBTYPE_PCM
            },
        }
    }

    /// The device's exclusive-mode verdict: the first `IsFormatSupported` answer that is not
    /// "wrong format", asked with the mix format and then float / 32 / 24 / 16-bit PCM at `rate`.
    /// Opens nothing.
    ///
    /// # Safety
    /// `client` is live and `mixp` came from its `GetMixFormat`.
    unsafe fn exclusive_answer(
        client: &IAudioClient,
        mixp: *const WAVEFORMATEX,
        mix: &Mix,
        rate: u32,
    ) -> i32 {
        // SAFETY: caller contract; every format pointer covers a complete WAVEFORMATEX(TENSIBLE).
        unsafe {
            let hr = client
                .IsFormatSupported(Audio::AUDCLNT_SHAREMODE_EXCLUSIVE, mixp, None)
                .0;
            if hr != HR_UNSUPPORTED_FORMAT {
                return hr;
            }
            for (float, bits) in [(true, 32), (false, 32), (false, 24), (false, 16)] {
                let w = wfx(float, bits, mix.ch, rate, mix.mask);
                let hr = client
                    .IsFormatSupported(Audio::AUDCLNT_SHAREMODE_EXCLUSIVE, &w.Format, None)
                    .0;
                if hr != HR_UNSUPPORTED_FORMAT {
                    return hr;
                }
            }
            HR_UNSUPPORTED_FORMAT
        }
    }

    enum Prop {
        Empty,
        U32(u32),
        Text(String),
        Other,
    }

    /// One property of the endpoint store; `None` when the store refuses the read.
    ///
    /// # Safety
    /// COM is initialised on this thread and `store` is live.
    unsafe fn prop(store: &IPropertyStore, key: &PROPERTYKEY) -> Option<Prop> {
        // SAFETY: caller contract; the PROPVARIANT is cleared exactly once after its fields were
        // read according to `vt`.
        unsafe {
            let mut pv: PROPVARIANT = store.GetValue(key).ok()?;
            let vt = pv.Anonymous.Anonymous.vt;
            let v = if vt == VT_EMPTY {
                Prop::Empty
            } else if vt == VT_UI4 {
                Prop::U32(pv.Anonymous.Anonymous.Anonymous.ulVal)
            } else if vt == VT_LPWSTR {
                let p = pv.Anonymous.Anonymous.Anonymous.pwszVal;
                Prop::Text(if p.is_null() {
                    String::new()
                } else {
                    p.to_string().unwrap_or_default()
                })
            } else {
                Prop::Other
            };
            let _ = PropVariantClear(&mut pv);
            Some(v)
        }
    }

    const FX_SYSFX_VALUE: &str = "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5";
    /// `PKEY_FX_{PreMix,PostMix,Stream,Mode,Endpoint}EffectClsid` and the three
    /// `PKEY_CompositeFX_*EffectClsid` pids.
    const FX_EFFECT_PIDS: [u32; 8] = [1, 2, 5, 6, 7, 13, 14, 15];

    struct FxRegistry {
        switch: Option<u32>,
        effects: bool,
    }

    /// The endpoint's `FxProperties` registry key (where the Sound settings "Audio enhancements"
    /// toggle stores `PKEY_AudioEndpoint_Disable_SysFx`). `None` = the key exists but could not
    /// be read; a missing key = nothing registered.
    fn fx_registry(id: &str, input: bool) -> Option<FxRegistry> {
        let guid = id.rsplit('.').next()?;
        let flow = if input { "Capture" } else { "Render" };
        let path = format!(
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\{flow}\\{guid}\\FxProperties"
        );
        let mut key = HKEY(std::ptr::null_mut());
        // SAFETY: read-only registry calls with valid out pointers; the key is closed before
        // returning.
        unsafe {
            let rc = RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                &HSTRING::from(path),
                None,
                KEY_READ,
                &mut key,
            );
            if rc == ERROR_FILE_NOT_FOUND {
                return Some(FxRegistry {
                    switch: None,
                    effects: false,
                });
            }
            if rc != ERROR_SUCCESS {
                return None;
            }
            let mut ty = REG_VALUE_TYPE::default();
            let mut data = [0u8; 4];
            let mut len = data.len() as u32;
            let rc = RegQueryValueExW(
                key,
                &HSTRING::from(FX_SYSFX_VALUE),
                None,
                Some(&mut ty),
                Some(data.as_mut_ptr()),
                Some(&mut len),
            );
            let switch = (rc == ERROR_SUCCESS && ty == REG_DWORD && len == 4)
                .then_some(u32::from_le_bytes(data));
            let effects = FX_EFFECT_PIDS.iter().any(|pid| {
                let name = format!("{{d04e05a6-594b-4fb6-a80d-01af5eed7d1d}},{pid}");
                let mut n = 0u32;
                RegQueryValueExW(key, &HSTRING::from(name), None, None, None, Some(&mut n))
                    == ERROR_SUCCESS
            });
            let _ = RegCloseKey(key);
            Some(FxRegistry { switch, effects })
        }
    }

    fn guid_text(g: &GUID) -> String {
        let d = g.data4;
        format!(
            "{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            g.data1, g.data2, g.data3, d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]
        )
    }

    /// The active power scheme GUID as text; the buffer Windows hands out is freed with
    /// `LocalFree`, as documented for `PowerGetActiveScheme`.
    pub(super) fn active_power_scheme() -> Option<String> {
        let mut p: *mut GUID = std::ptr::null_mut();
        // SAFETY: documented out pointer; the GUID is copied out and the allocation released once.
        unsafe {
            if PowerGetActiveScheme(None, &mut p) != ERROR_SUCCESS || p.is_null() {
                return None;
            }
            let g = *p;
            let _ = LocalFree(Some(HLOCAL(p.cast())));
            Some(guid_text(&g))
        }
    }

    /// All per-device items of one resolved endpoint (`id` = WASAPI endpoint id).
    pub(super) fn inspect(
        id: &str,
        name: &str,
        input: bool,
        cfg: &IoConfig,
        items: &mut Vec<CheckItem>,
    ) {
        let which = if input { "input" } else { "output" };
        let _com = Com::init();
        let Some(en) = enumerator() else {
            items.extend(unknown_items(
                input,
                "the audio device enumerator is unavailable",
            ));
            return;
        };
        let Some(dev) = device(&en, id) else {
            items.extend(unknown_items(input, &format!("endpoint {id} not found")));
            return;
        };
        let dev_name = format!("{which} \"{name}\"");

        // endpoint_volume
        match read_level(&dev) {
            Some(l) => {
                let (status, value) = volume_status(&l);
                let pct = (l.volume * 100.0).round();
                let detail = if l.muted {
                    format!("Windows reports the {dev_name} muted (slider at {pct:.0} %).")
                } else {
                    format!(
                        "Windows volume of the {dev_name} is {value} dB (slider at {pct:.0} %)."
                    )
                };
                items.push(item(
                    "endpoint_volume",
                    status,
                    Some(which),
                    Some(value),
                    detail,
                ));
            }
            None => items.push(item(
                "endpoint_volume",
                Status::Unknown,
                Some(which),
                None,
                format!("IAudioEndpointVolume of the {dev_name} could not be read."),
            )),
        }

        // sample_rate + exclusive_allowed (one IAudioClient, no Initialize)
        // SAFETY: COM calls on a live device; the mix format is freed exactly once.
        let probed = unsafe {
            dev.Activate::<IAudioClient>(CLSCTX_ALL, None)
                .ok()
                .and_then(|c| c.GetMixFormat().ok().map(|p| (c, p)))
                .map(|(client, mixp)| {
                    let mix = read_mix(mixp);
                    let hr = exclusive_answer(&client, mixp, &mix, cfg.sample_rate);
                    CoTaskMemFree(Some(mixp as *const _));
                    (mix, hr)
                })
        };
        match probed {
            Some((mix, hr)) => {
                let status = sample_rate_status(mix.rate, cfg.sample_rate);
                let mut detail = format!(
                    "The shared-mode mix format of the {dev_name} is {} Hz with {} channels; the engine asks for {} Hz",
                    mix.rate, mix.ch, cfg.sample_rate
                );
                detail.push_str(if status == Status::Ok {
                    "."
                } else {
                    " (shared hosts resample or refuse, exclusive mode is unaffected)."
                });
                items.push(item(
                    "sample_rate",
                    status,
                    Some(which),
                    Some(mix.rate.to_string()),
                    detail,
                ));
                let (status, value) = exclusive_status(hr);
                items.push(item(
                    "exclusive_allowed",
                    status,
                    Some(which),
                    value.map(str::to_owned),
                    format!(
                        "IsFormatSupported in exclusive mode on the {dev_name} answered 0x{:08X}: {}.",
                        hr as u32,
                        exclusive_answer_text(hr)
                    ),
                ));
            }
            None => {
                for id in ["sample_rate", "exclusive_allowed"] {
                    items.push(item(
                        id,
                        Status::Unknown,
                        Some(which),
                        None,
                        format!("No IAudioClient / mix format for the {dev_name}."),
                    ));
                }
            }
        }

        // enhancements + output_kind (property store, read only)
        // SAFETY: COM call on a live device, read access only.
        let store = unsafe { dev.OpenPropertyStore(STGM_READ) }.ok();
        // SAFETY: COM initialised on this thread; the store is live.
        let read = |key: &PROPERTYKEY| store.as_ref().and_then(|s| unsafe { prop(s, key) });

        // The documented switch, from the property store when it answers with a value and from
        // the endpoint's FxProperties registry key otherwise; the registered effect classes are
        // only in that registry key.
        let store_switch = match read(&PKEY_AudioEndpoint_Disable_SysFx) {
            Some(Prop::U32(v)) => Some(v),
            _ => None,
        };
        let reg = fx_registry(id, input);
        if store_switch.is_none() && reg.is_none() {
            items.push(item(
                "enhancements",
                Status::Unknown,
                Some(which),
                None,
                format!(
                    "PKEY_AudioEndpoint_Disable_SysFx of the {dev_name} is in neither the property store nor a readable FxProperties registry key."
                ),
            ));
        } else {
            let switch = store_switch.or(reg.as_ref().and_then(|r| r.switch));
            let effects = reg.as_ref().is_some_and(|r| r.effects);
            let (status, value) = enhancements_status(switch, effects);
            let stored = match (store_switch, switch) {
                (Some(v), _) => format!("is {v} in the endpoint property store"),
                (None, Some(v)) => format!("is {v} in the FxProperties registry key"),
                (None, None) => "is not stored".to_owned(),
            };
            let registered = match &reg {
                Some(r) if r.effects => "effect classes are registered",
                Some(_) => "no effect class is registered",
                None => "the registered effect classes could not be read",
            };
            items.push(item(
                "enhancements",
                status,
                Some(which),
                Some(value.to_owned()),
                format!(
                    "PKEY_AudioEndpoint_Disable_SysFx {stored} and {registered} for the {dev_name}."
                ),
            ));
        }

        if !input {
            let ff = match read(&PKEY_AudioEndpoint_FormFactor) {
                Some(Prop::U32(v)) => Some(v),
                _ => None,
            };
            let en_name = match read(&PKEY_Device_EnumeratorName) {
                Some(Prop::Text(t)) => t,
                _ => String::new(),
            };
            let kind = output_kind(name, &en_name, ff);
            let ff_text = ff.map_or("unknown".to_owned(), |v| v.to_string());
            let en_text = if en_name.is_empty() {
                "an unknown enumerator".to_owned()
            } else {
                en_name.clone()
            };
            items.push(item(
                "output_kind",
                output_kind_status(kind),
                Some(which),
                Some(kind.to_owned()),
                format!(
                    "The {dev_name} is enumerated by {en_text} with form factor {ff_text}, so it counts as {kind}."
                ),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voicemeeter::StripInfo;

    fn level(volume_db: f32, muted: bool) -> EndpointLevel {
        EndpointLevel {
            volume: 1.0,
            volume_db,
            muted,
        }
    }

    #[test]
    fn volume_thresholds() {
        assert_eq!(
            volume_status(&level(0.0, false)),
            (Status::Ok, "0.0".into())
        );
        assert_eq!(
            volume_status(&level(-0.04, false)),
            (Status::Ok, "0.0".into())
        );
        assert_eq!(
            volume_status(&level(-19.9, false)),
            (Status::Ok, "-19.9".into())
        );
        assert_eq!(
            volume_status(&level(-20.0, false)),
            (Status::Ok, "-20.0".into())
        );
        assert_eq!(
            volume_status(&level(-20.1, false)),
            (Status::Warn, "-20.1".into())
        );
        assert_eq!(
            volume_status(&level(0.0, true)),
            (Status::Fail, "muted".into())
        );
    }

    #[test]
    fn exclusive_from_hresult() {
        assert_eq!(
            exclusive_status(HR_EXCLUSIVE_MODE_NOT_ALLOWED),
            (Status::Fail, Some("disabled"))
        );
        assert_eq!(
            exclusive_status(HR_DEVICE_IN_USE),
            (Status::Warn, Some("in_use"))
        );
        for hr in [HR_S_OK, HR_S_FALSE, HR_UNSUPPORTED_FORMAT] {
            assert_eq!(
                exclusive_status(hr),
                (Status::Ok, Some("allowed")),
                "{hr:#x}"
            );
        }
        assert_eq!(
            exclusive_status(HR_DEVICE_INVALIDATED),
            (Status::Unknown, None)
        );
        assert_eq!(HR_DEVICE_IN_USE as u32, 0x8889_000A);
    }

    #[test]
    fn enhancements_switch_and_registration() {
        assert_eq!(enhancements_status(Some(0), true), (Status::Warn, "on"));
        assert_eq!(enhancements_status(Some(1), true), (Status::Ok, "off"));
        assert_eq!(enhancements_status(None, true), (Status::Warn, "on"));
        assert_eq!(enhancements_status(None, false), (Status::Ok, "off"));
    }

    #[test]
    fn sample_rate_equal_or_not() {
        assert_eq!(sample_rate_status(48_000, 48_000), Status::Ok);
        assert_eq!(sample_rate_status(44_100, 48_000), Status::Warn);
    }

    #[test]
    fn output_kind_from_raw_strings() {
        // Strings as the endpoint property store returned them on the development machine.
        assert_eq!(
            output_kind("Headphones (Bedroom display)", "BTHENUM", Some(3)),
            "bluetooth"
        );
        assert_eq!(
            output_kind(
                "Headset (soundcore Space Q45 Hands-Free)",
                "BTHHFENUM",
                Some(5)
            ),
            "bluetooth"
        );
        assert_eq!(
            output_kind(
                "Odyssey G85SD (NVIDIA High Definition Audio)",
                "HDAUDIO",
                Some(9)
            ),
            "hdmi"
        );
        assert_eq!(
            output_kind(
                "Digital Audio (HDMI) (High Definition Audio Device)",
                "HDAUDIO",
                None
            ),
            "hdmi"
        );
        assert_eq!(
            output_kind("Audio Interface Out (2- HD-II)", "USB", Some(3)),
            "usb"
        );
        assert_eq!(
            output_kind(
                "Samsung 5.1 Home Theater (Realtek(R) Audio)",
                "HDAUDIO",
                Some(8)
            ),
            "onboard"
        );
        assert_eq!(
            output_kind(
                "Voicemeeter Input (VB-Audio Voicemeeter VAIO)",
                "ROOT",
                Some(1)
            ),
            "virtual"
        );
        assert_eq!(
            output_kind("Speakers (NVIDIA Broadcast)", "ROOT", Some(9)),
            "virtual"
        );
        assert_eq!(output_kind("Something", "", None), "other");
        assert_eq!(output_kind_status("bluetooth"), Status::Warn);
        assert_eq!(output_kind_status("hdmi"), Status::Warn);
        assert_eq!(output_kind_status("usb"), Status::Ok);
        assert_eq!(output_kind_status("virtual"), Status::Ok);
    }

    #[test]
    fn power_plan_from_guid() {
        assert_eq!(
            power_plan("8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"),
            (Status::Ok, "high_performance".into())
        );
        assert_eq!(
            power_plan("{E9A42B02-D5DF-448D-AA00-03F14749EB61}"),
            (Status::Ok, "ultimate".into())
        );
        assert_eq!(
            power_plan("381b4222-f694-41f0-9685-ff5bb260df2e"),
            (Status::Warn, "balanced".into())
        );
        assert_eq!(
            power_plan("a1841308-3541-4fab-bc81-f71556f20b4a"),
            (Status::Fail, "power_saver".into())
        );
        assert_eq!(
            power_plan("E5579FAB-04B8-4E96-A84B-EBBC8BCC3FCB"),
            (
                Status::Unknown,
                "e5579fab-04b8-4e96-a84b-ebbc8bcc3fcb".into()
            )
        );
    }

    #[test]
    fn name_matching_is_case_insensitive_containment() {
        assert!(names_match(
            "Audio Interface Out (2- HD-II)",
            "audio interface out (2- hd-ii)"
        ));
        assert!(names_match(
            "Audio Interface Out (2- HD-II)",
            "Audio Interface Out"
        ));
        assert!(names_match(
            "Audio Interface Out",
            "Audio Interface Out (2- HD-II)"
        ));
        assert!(!names_match(
            "Audio Interface Out (2- HD-II)",
            "Audio Interface IN (2- HD-II)"
        ));
        assert!(!names_match("", "Audio Interface Out"));
        assert!(!names_match("Au", "Audio Interface Out"));
    }

    fn potato() -> VoicemeeterInfo {
        VoicemeeterInfo {
            installed: true,
            running: true,
            kind: Some("potato".into()),
            a1_device: Some("Audio Interface Out (2- HD-II)".into()),
            strips: vec![
                StripInfo {
                    index: 0,
                    kind: "hardware".into(),
                    device: "Microphone (USB Audio Device)".into(),
                    ..StripInfo::default()
                },
                StripInfo {
                    index: 4,
                    kind: "hardware".into(),
                    label: "Q-28 (L mixer, R DJI)".into(),
                    device: "Audio Interface IN (2- HD-II)".into(),
                    channels: vec![8, 9],
                    ..StripInfo::default()
                },
                StripInfo {
                    index: 5,
                    kind: "virtual".into(),
                    label: "Muzica".into(),
                    ..StripInfo::default()
                },
            ],
            ..VoicemeeterInfo::default()
        }
    }

    #[test]
    fn voicemeeter_ownership_a1_and_strips() {
        let vm = potato();
        let excl = Some(io::WASAPI_EXCLUSIVE);
        // Output on A1: a warning with the exclusive host, information otherwise.
        let it =
            voicemeeter_ownership(&vm, None, Some("Audio Interface Out (2- HD-II)"), excl).unwrap();
        assert_eq!((it.status, it.value.as_deref()), (Status::Warn, Some("a1")));
        assert_eq!(it.id, "voicemeeter_owns_device");
        assert_eq!(it.device, None);
        let it = voicemeeter_ownership(
            &vm,
            None,
            Some("Audio Interface Out (2- HD-II)"),
            Some("WASAPI"),
        )
        .unwrap();
        assert_eq!((it.status, it.value.as_deref()), (Status::Ok, Some("a1")));
        // Input on a hardware strip, shortened name as Voicemeeter may show it.
        let it = voicemeeter_ownership(&vm, Some("Audio Interface IN"), None, excl).unwrap();
        assert_eq!(
            (it.status, it.value.as_deref()),
            (Status::Warn, Some("strip:4"))
        );
        assert!(it.detail.contains("Q-28"), "{}", it.detail);
        // Both held: A1 comes first, the strip is still named.
        let it = voicemeeter_ownership(
            &vm,
            Some("Audio Interface IN (2- HD-II)"),
            Some("Audio Interface Out (2- HD-II)"),
            excl,
        )
        .unwrap();
        assert_eq!(it.value.as_deref(), Some("a1"));
        assert!(it.detail.contains("strip 4"), "{}", it.detail);
        // Neither held, or Voicemeeter not running: no item.
        assert!(
            voicemeeter_ownership(&vm, Some("Microphone (PRO X 2)"), Some("Speakers"), excl)
                .is_none()
        );
        let off = VoicemeeterInfo {
            running: false,
            ..potato()
        };
        assert!(
            voicemeeter_ownership(&off, None, Some("Audio Interface Out (2- HD-II)"), excl)
                .is_none()
        );
    }

    #[test]
    fn serde_forms() {
        assert_eq!(serde_json::to_string(&Status::Ok).unwrap(), "\"ok\"");
        assert_eq!(
            serde_json::to_string(&Status::Unknown).unwrap(),
            "\"unknown\""
        );
        assert_eq!(
            serde_json::from_str::<Status>("\"warn\"").unwrap(),
            Status::Warn
        );
        let it = item("power_plan", Status::Fail, None, None, "x".into());
        assert_eq!(
            serde_json::to_string(&it).unwrap(),
            r#"{"id":"power_plan","status":"fail","device":null,"value":null,"detail":"x"}"#
        );
        let it = item(
            "endpoint_volume",
            Status::Warn,
            Some("output"),
            Some("-21.5".into()),
            "y".into(),
        );
        assert_eq!(
            serde_json::to_string(&it).unwrap(),
            r#"{"id":"endpoint_volume","status":"warn","device":"output","value":"-21.5","detail":"y"}"#
        );
        let back: Checkup = serde_json::from_str(r#"{"items":[]}"#).unwrap();
        assert_eq!(back, Checkup::default());
    }

    /// Shape only: no panic, known ids, at most one item per (id, device). Passes on a machine
    /// without any audio device (items are then `unknown` or absent).
    #[cfg(windows)]
    #[test]
    fn windows_smoke_run_and_level() {
        let _ = endpoint_level(None, false);
        let _ = endpoint_level(None, true);
        let r = run(&IoConfig::default());
        let mut seen = std::collections::HashSet::new();
        for it in &r.items {
            assert!(ITEM_IDS.contains(&it.id.as_str()), "{}", it.id);
            assert!(
                seen.insert((it.id.clone(), it.device.clone())),
                "duplicate {} {:?}",
                it.id,
                it.device
            );
            assert!(!it.detail.is_empty());
        }
        assert!(r.items.iter().any(|i| i.id == "power_plan"));
        // No endpoints with the simulated host: machine-wide items only.
        let null = run(&IoConfig {
            host: Some(io::NULL_HOST.into()),
            ..IoConfig::default()
        });
        assert!(null.items.iter().all(|i| i.device.is_none()));
    }

    /// Prints this machine's checkup; run by hand through the isolated copy.
    #[cfg(windows)]
    #[test]
    #[ignore = "prints the checkup of this machine"]
    fn print_checkup_on_this_machine() {
        let hd2 = IoConfig {
            input: Some("Audio Interface IN (2- HD-II)".into()),
            output: Some("Audio Interface Out (2- HD-II)".into()),
            sample_rate: 48_000,
            host: Some(io::WASAPI_EXCLUSIVE.into()),
            ..IoConfig::default()
        };
        for (label, cfg) in [
            ("hd-ii exclusive 48k", hd2),
            ("defaults", IoConfig::default()),
        ] {
            println!(
                "=== {label}\n{}",
                serde_json::to_string_pretty(&run(&cfg)).unwrap()
            );
        }
    }
}
