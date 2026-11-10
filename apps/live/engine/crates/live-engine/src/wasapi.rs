//! Own WASAPI backend (Windows): one event-driven duplex thread registered with MMCSS "Pro Audio".
//!
//! * [`Mode::Exclusive`] — `AUDCLNT_SHAREMODE_EXCLUSIVE`: the engine owns the endpoint, no Windows
//!   mixer, buffer = one device period (f32 / i32 / i24 / i16, whatever the driver takes).
//! * [`Mode::LowLatency`] — shared mode through `IAudioClient3::InitializeSharedAudioStream` with the
//!   smallest engine period the driver offers; other applications keep using the device.
//!
//! COM objects never leave the audio thread. The thread opens both endpoints, asks the caller for the
//! callbacks (channel counts are only known then), reports the result and runs until stopped.

use crate::io::IoError;
use crate::sample::{Fmt, align_period, decode, encode, frames_to_hns, hns_to_frames};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use windows::Win32::Foundation::{CloseHandle, HANDLE, S_OK, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Media::Audio::{
    self, IAudioCaptureClient, IAudioClient, IAudioClient3, IAudioRenderClient, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::Media::KernelStreaming::KSDATAFORMAT_SUBTYPE_PCM;
use windows::Win32::Media::Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
    CoUninitialize,
};
use windows::Win32::System::Threading::{
    AVRT_PRIORITY_CRITICAL, AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW,
    AvSetMmThreadPriority, CreateEventW, WaitForMultipleObjects,
};
use windows::core::{HSTRING, Interface, w};

const TAG_PCM: u16 = 1;
const TAG_FLOAT: u16 = 3;
const TAG_EXTENSIBLE: u16 = 0xFFFE;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Exclusive,
    LowLatency,
}

pub type InCb = Box<dyn FnMut(&[f32]) + Send>;
pub type OutCb = Box<dyn FnMut(&mut [f32]) + Send>;
/// Called on the audio thread once both endpoints are open.
pub type Make = Box<dyn FnOnce(&Opened) -> Result<(InCb, OutCb), IoError> + Send>;

pub struct Opened {
    pub in_ch: u16,
    pub out_ch: u16,
    /// Frames per capture event / per render event.
    pub in_period: u32,
    pub out_period: u32,
    pub notes: Vec<String>,
}

pub struct Shared {
    pub alive: Arc<AtomicBool>,
    pub last_error: Arc<Mutex<Option<String>>>,
    pub driver_xruns: Arc<AtomicU32>,
}

/// Stops and joins the audio thread on drop.
pub struct Handle {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Registers the calling thread with MMCSS "Pro Audio" at critical priority. The registration ends
/// with the thread (or with [`Mmcss`] drop). Returns None when Windows refuses.
pub struct Mmcss(HANDLE);

impl Mmcss {
    pub fn join() -> Option<Mmcss> {
        let mut index = 0u32;
        // SAFETY: plain Win32 call with a static string and a valid out pointer.
        let h = unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut index) }.ok()?;
        // SAFETY: `h` is the live MMCSS handle of this thread.
        let _ = unsafe { AvSetMmThreadPriority(h, AVRT_PRIORITY_CRITICAL) };
        Some(Mmcss(h))
    }

    /// Keep the registration until the thread exits (callback threads we do not own).
    pub fn keep(self) {
        std::mem::forget(self);
    }
}

impl Drop for Mmcss {
    fn drop(&mut self) {
        // SAFETY: handle returned by AvSetMmThreadCharacteristicsW on this thread.
        let _ = unsafe { AvRevertMmThreadCharacteristics(self.0) };
    }
}

fn describe_text(what: &str, e: &windows::core::Error) -> String {
    let c = e.code();
    let text = if c == Audio::AUDCLNT_E_DEVICE_IN_USE {
        "the device is in use by another application (free it there first, e.g. Voicemeeter's hardware in/out; exclusive mode needs the device to itself)".to_string()
    } else if c == Audio::AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED {
        "exclusive mode is disabled for this device (Sound settings > device > Advanced > allow applications to take exclusive control)".to_string()
    } else if c == Audio::AUDCLNT_E_UNSUPPORTED_FORMAT {
        "the device does not accept this sample rate / format".to_string()
    } else if c == Audio::AUDCLNT_E_DEVICE_INVALIDATED {
        "the device was removed or reconfigured".to_string()
    } else {
        format!("{} (0x{:08X})", e.message(), c.0 as u32)
    };
    format!("{what}: {text}")
}

fn describe(what: &str, e: &windows::core::Error) -> IoError {
    IoError::Device(describe_text(what, e))
}

fn wfx(fmt: Fmt, ch: u16, rate: u32, mask: u32) -> WAVEFORMATEXTENSIBLE {
    let bytes = fmt.bytes() as u16;
    let valid = match fmt {
        Fmt::I32 { valid } => valid as u16,
        _ => bytes * 8,
    };
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: TAG_EXTENSIBLE,
            nChannels: ch,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * ch as u32 * bytes as u32,
            nBlockAlign: ch * bytes,
            wBitsPerSample: bytes * 8,
            cbSize: 22,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: valid,
        },
        dwChannelMask: mask,
        SubFormat: if fmt == Fmt::F32 {
            KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
        } else {
            KSDATAFORMAT_SUBTYPE_PCM
        },
    }
}

struct MixFormat {
    fmt: Option<Fmt>,
    ch: u16,
    rate: u32,
    mask: u32,
}

/// # Safety
/// `p` must point at a WAVEFORMATEX (followed by its `cbSize` extra bytes) returned by WASAPI.
unsafe fn parse(p: *const WAVEFORMATEX) -> MixFormat {
    // SAFETY: caller contract; fields are read by value (packed struct).
    unsafe {
        let f = *p;
        let (tag, bits, ch, rate, cb) = (
            f.wFormatTag,
            f.wBitsPerSample,
            f.nChannels,
            f.nSamplesPerSec,
            f.cbSize,
        );
        let default_mask = match ch {
            1 => 0x4,
            2 => 0x3,
            _ => 0,
        };
        let pcm = |valid: u16| match bits {
            16 => Some(Fmt::I16),
            24 => Some(Fmt::I24),
            32 => Some(Fmt::I32 {
                valid: if valid == 24 { 24 } else { 32 },
            }),
            _ => None,
        };
        let (fmt, mask) = if tag == TAG_EXTENSIBLE && cb >= 22 {
            let e = *(p as *const WAVEFORMATEXTENSIBLE);
            let sub = e.SubFormat;
            let valid = e.Samples.wValidBitsPerSample;
            let fmt = if sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT && bits == 32 {
                Some(Fmt::F32)
            } else if sub == KSDATAFORMAT_SUBTYPE_PCM {
                pcm(valid)
            } else {
                None
            };
            (fmt, e.dwChannelMask)
        } else if tag == TAG_FLOAT && bits == 32 {
            (Some(Fmt::F32), default_mask)
        } else if tag == TAG_PCM {
            (pcm(bits), default_mask)
        } else {
            (None, default_mask)
        };
        MixFormat {
            fmt,
            ch,
            rate,
            mask,
        }
    }
}

struct Side {
    client: IAudioClient,
    fmt: Fmt,
    ch: u16,
    /// Frames handled per event.
    period: u32,
    /// Endpoint buffer size in frames.
    buffer: u32,
    event: HANDLE,
}

impl Drop for Side {
    fn drop(&mut self) {
        // SAFETY: stopping an initialized client and closing our own event handle.
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

fn activate(dev: &IMMDevice, what: &str) -> Result<IAudioClient, IoError> {
    // SAFETY: COM call on a live device on a COM-initialized thread.
    unsafe { dev.Activate::<IAudioClient>(CLSCTX_ALL, None) }.map_err(|e| describe(what, &e))
}

fn open(
    en: &IMMDeviceEnumerator,
    id: &str,
    what: &str,
    mode: Mode,
    rate: u32,
    want: u32,
) -> Result<Side, IoError> {
    // SAFETY: every call below is a COM method on objects created on this thread; out pointers
    // are valid locals; the mix format is freed with CoTaskMemFree exactly once.
    unsafe {
        let dev = en
            .GetDevice(&HSTRING::from(id))
            .map_err(|_| IoError::NotFound(format!("{what} device {id}")))?;
        let mut client = activate(&dev, what)?;
        let mixp = client.GetMixFormat().map_err(|e| describe(what, &e))?;
        let mix = parse(mixp);
        if mix.ch == 0 {
            CoTaskMemFree(Some(mixp as *const _));
            return Err(IoError::Config(format!(
                "{what}: the device has no channels"
            )));
        }
        let (fmt, period) = match mode {
            Mode::Exclusive => {
                CoTaskMemFree(Some(mixp as *const _));
                let candidates = [
                    Fmt::F32,
                    Fmt::I32 { valid: 32 },
                    Fmt::I32 { valid: 24 },
                    Fmt::I24,
                    Fmt::I16,
                ];
                // A refusal that is not about the format (device held, exclusive mode disabled)
                // is the real answer: report it instead of "no format".
                let mut refused = None;
                let chosen = candidates.into_iter().find(|f| {
                    let w = wfx(*f, mix.ch, rate, mix.mask);
                    let hr = client.IsFormatSupported(
                        Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                        &w.Format,
                        None,
                    );
                    if hr.is_err() && hr != Audio::AUDCLNT_E_UNSUPPORTED_FORMAT {
                        refused = Some(hr);
                    }
                    hr == S_OK
                });
                let Some(fmt) = chosen else {
                    if let Some(hr) = refused
                        && (hr == Audio::AUDCLNT_E_DEVICE_IN_USE
                            || hr == Audio::AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED
                            || hr == Audio::AUDCLNT_E_DEVICE_INVALIDATED)
                    {
                        return Err(describe(what, &windows::core::Error::from_hresult(hr)));
                    }
                    return Err(IoError::Config(format!(
                        "{what}: no exclusive-mode format at {rate} Hz with {} channels{}",
                        mix.ch,
                        refused
                            .map(|h| format!(" (driver answered 0x{:08X})", h.0 as u32))
                            .unwrap_or_default()
                    )));
                };
                let w = wfx(fmt, mix.ch, rate, mix.mask);
                let mut min = 0i64;
                let _ = client.GetDevicePeriod(None, Some(&mut min));
                let mut hns = frames_to_hns(want, rate).max(min);
                let mut attempt = 0;
                loop {
                    let r = client.Initialize(
                        Audio::AUDCLNT_SHAREMODE_EXCLUSIVE,
                        Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                        hns,
                        hns,
                        &w.Format,
                        None,
                    );
                    match r {
                        Ok(()) => break,
                        Err(e)
                            if e.code() == Audio::AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED
                                && attempt == 0 =>
                        {
                            // The driver wants an aligned size: the failed client reports it, and
                            // the retry needs a fresh client (the old one is released first).
                            let n = client.GetBufferSize().map_err(|e| describe(what, &e))?;
                            hns = frames_to_hns(n, rate);
                            drop(client);
                            client = activate(&dev, what)?;
                            attempt = 1;
                        }
                        Err(e) => return Err(describe(what, &e)),
                    }
                }
                (fmt, 0)
            }
            Mode::LowLatency => {
                let free = |p: *mut WAVEFORMATEX| CoTaskMemFree(Some(p as *const _));
                let Some(fmt) = mix.fmt else {
                    free(mixp);
                    return Err(IoError::Config(format!(
                        "{what}: unknown shared mix format"
                    )));
                };
                if mix.rate != rate {
                    free(mixp);
                    return Err(IoError::Config(format!(
                        "{what}: the device runs at {} Hz in shared mode, requested {rate} (change it in Sound settings or use the exclusive host)",
                        mix.rate
                    )));
                }
                let c3 = match client.cast::<IAudioClient3>() {
                    Ok(c) => c,
                    Err(e) => {
                        free(mixp);
                        return Err(describe(what, &e));
                    }
                };
                let (mut def, mut fund, mut min, mut max) = (0u32, 0u32, 0u32, 0u32);
                let r = c3
                    .GetSharedModeEnginePeriod(mixp, &mut def, &mut fund, &mut min, &mut max)
                    .and_then(|()| {
                        let period = align_period(want, fund, min, max);
                        c3.InitializeSharedAudioStream(
                            Audio::AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                            period,
                            mixp,
                            None,
                        )
                        .map(|()| {
                            // The engine may already run another period for an earlier client.
                            // Feed the larger of the two per event: never less than is consumed.
                            let mut cur = 0u32;
                            let mut pf = std::ptr::null_mut();
                            if c3
                                .GetCurrentSharedModeEnginePeriod(&mut pf, &mut cur)
                                .is_ok()
                            {
                                if !pf.is_null() {
                                    free(pf);
                                }
                                if cur > 0 {
                                    return period.max(cur);
                                }
                            }
                            period
                        })
                    });
                free(mixp);
                (fmt, r.map_err(|e| describe(what, &e))?)
            }
        };
        let buffer = client.GetBufferSize().map_err(|e| describe(what, &e))?;
        let event = CreateEventW(None, false, false, None).map_err(|e| describe(what, &e))?;
        let side = Side {
            client,
            fmt,
            ch: mix.ch,
            period: if mode == Mode::Exclusive {
                buffer
            } else {
                period
            },
            buffer,
            event,
        };
        side.client
            .SetEventHandle(event)
            .map_err(|e| describe(what, &e))?;
        Ok(side)
    }
}

struct Args {
    mode: Mode,
    input: String,
    output: String,
    rate: u32,
    buffer: u32,
    make: Make,
    stop: Arc<AtomicBool>,
    shared: Shared,
}

fn fail(shared: &Shared, text: String) {
    log::error!("wasapi: {text}");
    if let Ok(mut s) = shared.last_error.lock() {
        *s = Some(text);
    }
    shared.alive.store(false, Ordering::Relaxed);
}

fn run(a: Args, ready: mpsc::SyncSender<Result<Opened, IoError>>) {
    let Args {
        mode,
        input,
        output,
        rate,
        buffer,
        make,
        stop,
        shared,
    } = a;
    // SAFETY: COM objects are created, used and released on this thread only.
    unsafe {
        let en: IMMDeviceEnumerator = match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
        {
            Ok(e) => e,
            Err(e) => {
                let _ = ready.send(Err(describe("device enumerator", &e)));
                return;
            }
        };
        let setup = (|| {
            let inp = open(&en, &input, "input", mode, rate, buffer)?;
            let out = open(&en, &output, "output", mode, rate, buffer)?;
            let cap = inp
                .client
                .GetService::<IAudioCaptureClient>()
                .map_err(|e| describe("input", &e))?;
            let ren = out
                .client
                .GetService::<IAudioRenderClient>()
                .map_err(|e| describe("output", &e))?;
            let mut opened = Opened {
                in_ch: inp.ch,
                out_ch: out.ch,
                in_period: inp.period,
                out_period: out.period,
                notes: vec![format!(
                    "{}: input {} / {} frames, output {} / {} frames",
                    if mode == Mode::Exclusive {
                        "exclusive"
                    } else {
                        "shared low-latency"
                    },
                    inp.fmt.label(),
                    inp.period,
                    out.fmt.label(),
                    out.period
                )],
            };
            let (on_in, on_out) = make(&opened)?;
            let mmcss = Mmcss::join();
            opened.notes.push(
                if mmcss.is_some() {
                    "MMCSS Pro Audio"
                } else {
                    "MMCSS Pro Audio refused: normal thread priority"
                }
                .into(),
            );
            Ok::<_, IoError>((inp, out, cap, ren, on_in, on_out, opened, mmcss))
        })();
        let (inp, out, cap, ren, mut on_in, mut on_out, opened, mmcss) = match setup {
            Ok(s) => s,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };

        let (ich, och) = (inp.ch as usize, out.ch as usize);
        let mut in_buf = vec![0.0f32; inp.buffer.max(inp.period) as usize * ich];
        let mut out_buf = vec![0.0f32; out.buffer.max(out.period) as usize * och];

        // One period of silence so the first render event finds the device fed.
        let start = (|| {
            if mode == Mode::Exclusive {
                ren.GetBuffer(out.buffer)?;
                ren.ReleaseBuffer(out.buffer, Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)?;
            }
            inp.client.Start()?;
            out.client.Start()
        })();
        if let Err(e) = start {
            let _ = ready.send(Err(describe("start", &e)));
            return;
        }
        let _ = ready.send(Ok(opened));

        let events = [inp.event, out.event];
        let mut first_capture = true;
        // Output frames rendered since the last capture packet: a capture side that stops
        // delivering would otherwise play silence forever with the stream reported alive.
        let mut starved = 0u64;
        while !stop.load(Ordering::Relaxed) {
            let w = WaitForMultipleObjects(&events, false, 2000);
            let r: windows::core::Result<()> = if w.0 == WAIT_OBJECT_0.0 {
                (|| {
                    loop {
                        let mut p = std::ptr::null_mut();
                        let (mut n, mut flags) = (0u32, 0u32);
                        match cap.GetBuffer(&mut p, &mut n, &mut flags, None, None) {
                            Ok(()) => {}
                            // Exclusive mode: no packet this pass, wait for the next event.
                            Err(e) if e.code() == Audio::AUDCLNT_E_BUFFER_ERROR => {
                                shared.driver_xruns.fetch_add(1, Ordering::Relaxed);
                                return Ok(());
                            }
                            Err(e) => return Err(e),
                        }
                        if n == 0 {
                            return Ok(());
                        }
                        let silent = flags & Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                        if p.is_null() && !silent {
                            return cap.ReleaseBuffer(n);
                        }
                        starved = 0;
                        let frames = (n as usize).min(in_buf.len() / ich);
                        let dst = &mut in_buf[..frames * ich];
                        if silent {
                            dst.fill(0.0);
                        } else {
                            let bytes = frames * ich * inp.fmt.bytes();
                            decode(inp.fmt, std::slice::from_raw_parts(p, bytes), dst);
                        }
                        if !first_capture
                            && flags & Audio::AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0
                        {
                            shared.driver_xruns.fetch_add(1, Ordering::Relaxed);
                        }
                        first_capture = false;
                        on_in(dst);
                        cap.ReleaseBuffer(n)?;
                        if mode == Mode::Exclusive {
                            // One buffer per event; shared mode drains every queued packet.
                            return Ok(());
                        }
                    }
                })()
            } else if w.0 == WAIT_OBJECT_0.0 + 1 {
                (|| {
                    let n = if mode == Mode::Exclusive {
                        out.buffer
                    } else {
                        let pad = out.client.GetCurrentPadding()?;
                        out.buffer.saturating_sub(pad).min(out.period)
                    };
                    if n == 0 {
                        return Ok(());
                    }
                    starved += n as u64;
                    let p = match ren.GetBuffer(n) {
                        Ok(p) => p,
                        Err(e) if e.code() == Audio::AUDCLNT_E_BUFFER_TOO_LARGE => {
                            shared.driver_xruns.fetch_add(1, Ordering::Relaxed);
                            return Ok(());
                        }
                        Err(e) => return Err(e),
                    };
                    let src = &mut out_buf[..n as usize * och];
                    on_out(src);
                    let bytes = n as usize * och * out.fmt.bytes();
                    encode(out.fmt, src, std::slice::from_raw_parts_mut(p, bytes));
                    ren.ReleaseBuffer(n, 0)
                })()
            } else if w == WAIT_TIMEOUT {
                fail(&shared, "the device sent no audio events for 2 s".into());
                break;
            } else {
                fail(&shared, "waiting for the device failed".into());
                break;
            };
            if let Err(e) = r {
                fail(&shared, describe_text("stream", &e));
                break;
            }
            // Slow-starting inputs get longer until their first packet.
            let allowance = if first_capture { 5 } else { 2 };
            if starved > rate as u64 * allowance {
                fail(
                    &shared,
                    format!("the input delivered no audio for {allowance} s"),
                );
                break;
            }
        }
        drop(mmcss);
    }
}

/// Marks the stream dead when the audio thread unwinds (a panicking callback must not look alive).
struct PanicFlag {
    alive: Arc<AtomicBool>,
    last_error: Arc<Mutex<Option<String>>>,
}

impl Drop for PanicFlag {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.alive.store(false, Ordering::Relaxed);
            if let Ok(mut s) = self.last_error.lock() {
                *s = Some("the audio thread panicked".into());
            }
        }
    }
}

/// Open both endpoints (WASAPI endpoint ids) and start the audio thread.
pub fn start(
    mode: Mode,
    input: String,
    output: String,
    rate: u32,
    buffer: u32,
    make: Make,
    shared: Shared,
) -> Result<(Handle, Opened), IoError> {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::sync_channel(1);
    let on_panic = PanicFlag {
        alive: shared.alive.clone(),
        last_error: shared.last_error.clone(),
    };
    let args = Args {
        mode,
        input,
        output,
        rate,
        buffer,
        make,
        stop: stop.clone(),
        shared,
    };
    let thread = std::thread::Builder::new()
        .name("live-wasapi".into())
        .spawn(move || {
            let _on_panic = on_panic;
            // SAFETY: balanced with CoUninitialize below once every COM object of `run` is gone.
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            run(args, tx);
            if com.is_ok() {
                // SAFETY: CoInitializeEx succeeded on this thread.
                unsafe { CoUninitialize() };
            }
        })
        .map_err(|e| IoError::Device(format!("audio thread: {e}")))?;
    let handle = Handle {
        stop,
        thread: Some(thread),
    };
    match rx.recv() {
        Ok(Ok(o)) => Ok((handle, o)),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(IoError::Device("audio thread died while opening".into())),
    }
}

/// Low-latency shared mode of an endpoint: (minimum period, default period, mixer rate), the two
/// periods in frames at that mixer rate.
pub type SharedPeriods = (u32, u32, u32);

/// Period limits of an endpoint: the exclusive minimum in frames at `rate`, and - when the driver
/// has a low-latency shared mode - its [`SharedPeriods`].
pub fn periods(id: &str, rate: u32) -> Option<(u32, Option<SharedPeriods>)> {
    // SAFETY: COM used on the calling thread only; MTA init is balanced when it succeeded.
    unsafe {
        let com = CoInitializeEx(None, COINIT_MULTITHREADED);
        let r = (|| {
            let en: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let dev = en.GetDevice(&HSTRING::from(id)).ok()?;
            let client = dev.Activate::<IAudioClient>(CLSCTX_ALL, None).ok()?;
            let mut min = 0i64;
            client.GetDevicePeriod(None, Some(&mut min)).ok()?;
            let shared = (|| {
                let c3 = client.cast::<IAudioClient3>().ok()?;
                let mixp = client.GetMixFormat().ok()?;
                let mix_rate = (*mixp).nSamplesPerSec;
                let (mut def, mut fund, mut lo, mut hi) = (0u32, 0u32, 0u32, 0u32);
                let ok = c3
                    .GetSharedModeEnginePeriod(mixp, &mut def, &mut fund, &mut lo, &mut hi)
                    .is_ok();
                CoTaskMemFree(Some(mixp as *const _));
                ok.then_some((lo, def, mix_rate))
            })();
            Some((hns_to_frames(min, rate), shared))
        })();
        if com.is_ok() {
            CoUninitialize();
        }
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_format_survives_its_wave_header() {
        for f in [
            Fmt::F32,
            Fmt::I32 { valid: 32 },
            Fmt::I32 { valid: 24 },
            Fmt::I24,
            Fmt::I16,
        ] {
            let w = wfx(f, 2, 48_000, 0x3);
            // SAFETY: the pointer covers a complete WAVEFORMATEXTENSIBLE.
            let m = unsafe { parse(std::ptr::from_ref(&w).cast()) };
            assert_eq!((m.fmt, m.ch, m.rate, m.mask), (Some(f), 2, 48_000, 0x3));
        }
    }

    #[test]
    fn plain_pcm_and_float_headers_parse() {
        let mut w = wfx(Fmt::I16, 2, 44_100, 0).Format;
        w.wFormatTag = TAG_PCM;
        w.cbSize = 0;
        // SAFETY: a complete WAVEFORMATEX with no extra bytes.
        let m = unsafe { parse(&raw const w) };
        assert_eq!(
            (m.fmt, m.ch, m.rate, m.mask),
            (Some(Fmt::I16), 2, 44_100, 0x3)
        );
        w.wFormatTag = TAG_FLOAT;
        w.wBitsPerSample = 32;
        // SAFETY: as above.
        let m = unsafe { parse(&raw const w) };
        assert_eq!(m.fmt, Some(Fmt::F32));
    }

    #[test]
    fn a_panicking_audio_thread_marks_the_stream_dead() {
        let alive = Arc::new(AtomicBool::new(true));
        let last_error = Arc::new(Mutex::new(None));
        let flag = PanicFlag {
            alive: alive.clone(),
            last_error: last_error.clone(),
        };
        let t = std::thread::spawn(move || {
            let _flag = flag;
            panic!("simulated callback panic");
        });
        assert!(t.join().is_err());
        assert!(!alive.load(Ordering::Relaxed));
        assert!(last_error.lock().unwrap().is_some());
    }

    /// Thread start, COM, the ready channel and the join on drop, without any hardware.
    #[test]
    fn an_unknown_endpoint_fails_without_hanging() {
        let shared = Shared {
            alive: Arc::new(AtomicBool::new(true)),
            last_error: Arc::new(Mutex::new(None)),
            driver_xruns: Arc::new(AtomicU32::new(0)),
        };
        let make: Make = Box::new(|_| Err(IoError::Config("must not be reached".into())));
        let r = start(
            Mode::Exclusive,
            "no-such-endpoint".into(),
            "no-such-endpoint".into(),
            48_000,
            128,
            make,
            shared,
        );
        // NotFound with an audio service; a machine without one fails earlier (Device).
        assert!(matches!(r, Err(IoError::NotFound(_) | IoError::Device(_))));
    }
}
