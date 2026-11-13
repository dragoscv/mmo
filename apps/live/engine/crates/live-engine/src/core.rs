//! The audio-thread side: chain + scene spill-over + buses + meters + latency probe.
//! Device-independent so it is unit-tested and used for offline rendering.

use crate::latency::{LatencyProbe, Phase};
use live_dsp::chain::MAX_INSERTS;
use live_dsp::{Chain, FxKind, Insert, Smoothed, TuneStatus, db_to_lin};

/// Effects that shift pitch, and so add the shifter's latency to everything that passes through
/// them. The monitor option "tuned only for the audience" leaves exactly these out of the chain
/// that feeds the in-ear bus. This is the one list: `Session` builds the monitor chain with it
/// and [`Core`] translates insert positions between the two chains with it.
pub fn is_pitch_fx(kind: FxKind) -> bool {
    matches!(kind, FxKind::Autotune | FxKind::Harmonizer)
}

/// Messages from the control thread. Boxes are allocated on the control thread; the audio
/// thread only moves pointers and sends the old ones back through [`Garbage`].
///
/// While a monitor chain exists (see [`Command::SetMonitorChain`]) `SetParam`, `SetEnabled`,
/// `RemoveInsert`, `MoveInsert` and `Reset` reach it too: insert ids are the link, an id the
/// monitor chain does not have (a pitch effect) changes nothing there, and positions are
/// translated to its order.
pub enum Command {
    SetParam {
        insert: u32,
        index: usize,
        value: f32,
    },
    SetEnabled {
        insert: u32,
        on: bool,
    },
    AddInsert {
        at: usize,
        insert: Box<Insert>,
    },
    /// `AddInsert` while a monitor chain exists: `monitor` is a second instance of the same
    /// effect with the same id (never a pitch effect: those go in with `AddInsert`). `at` is the
    /// position in the main chain; the position in the monitor chain is derived from it.
    AddInsertBoth {
        at: usize,
        insert: Box<Insert>,
        monitor: Box<Insert>,
    },
    RemoveInsert {
        insert: u32,
    },
    MoveInsert {
        insert: u32,
        to: usize,
    },
    /// Scene / preset change: the old chain keeps ringing out (fed silence) for its tail.
    /// Sent while a monitor chain exists it turns that chain off (the monitor crossfades back to
    /// the main chain): no second chain can be built on the audio thread. `Session` sends
    /// [`Command::SwapChains`] instead.
    SwapChain {
        chain: Box<Chain>,
    },
    /// Scene / preset change with the monitor option on: both chains change in the same block
    /// and each old chain rings out on its own bus.
    SwapChains {
        chain: Box<Chain>,
        monitor: Box<Chain>,
    },
    /// Monitor option "tuned only for the audience". `Some` = feed the monitor bus from this
    /// chain (the main chain minus the pitch effects, same insert ids): it runs unheard for
    /// 50 ms, then a 10 ms crossfade moves the monitor bus to it. `None` = 10 ms crossfade back
    /// to the main chain, then the chain comes back through [`Core::take_finished_tail`].
    SetMonitorChain {
        chain: Option<Box<Chain>>,
    },
    InputGain(f32),
    MainGain(f32),
    MonitorGain(f32),
    /// 0 = processed only, 1 = dry only in the in-ear monitor.
    MonitorDry(f32),
    /// Dry pass-through on every bus (instant safe mode, 10 ms crossfade).
    Bypass(bool),
    /// Silence every output (10 ms fade).
    Mute(bool),
    StartLatencyProbe,
    /// Clear every delay line / reverb tail (panic button).
    Reset,
}

/// Returned to the control thread to be dropped off the audio thread.
pub enum Garbage {
    Chain(Box<Chain>),
    Insert(Box<Insert>),
}

pub const METER_SLOTS: usize = MAX_INSERTS;

/// Ceiling of the safety stage: −1 dBFS. No bus ever carries a sample above it.
pub const SAFETY_CEILING: f32 = 0.891_250_9;
/// Faders ramp down in 10 ms but up in 300 ms: a wrong "+12 dB" from a remote never arrives as
/// a slap.
const GAIN_DOWN_MS: f32 = 10.0;
const GAIN_UP_MS: f32 = 300.0;
/// A monitor chain switched on while singing starts with empty state: its compressor has not
/// pulled the level down yet, its gate is closed, its parameters still ramp to their values.
/// It runs unheard for this long before the 10 ms crossfade to it starts. The figure is chosen
/// from the effects' time constants (not measured): it covers every parameter ramp except the
/// delay time (80 ms).
const MONITOR_WARMUP_MS: f32 = 50.0;

/// Last stage of a bus, after the faders. It is not an insert: no control can remove, disable or
/// reorder it, and bypass, the dry monitor and the latency click all pass through it.
/// Zero latency (in-ear monitoring): stereo-linked, instant attack, 120 ms release, then an
/// exact clamp at [`SAFETY_CEILING`]. Non-finite samples become silence.
struct Safety {
    gain: f32,
    release: f32,
}

impl Safety {
    fn new(sample_rate: f32) -> Self {
        Self {
            gain: 1.0,
            release: 1.0 - (-1.0 / (0.120 * sample_rate)).exp(),
        }
    }

    #[inline]
    fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        if !(l.is_finite() && r.is_finite()) {
            return (0.0, 0.0);
        }
        let pk = l.abs().max(r.abs());
        if pk * self.gain > SAFETY_CEILING {
            self.gain = SAFETY_CEILING / pk;
        } else {
            self.gain += self.release * (1.0 - self.gain);
        }
        (
            (l * self.gain).clamp(-SAFETY_CEILING, SAFETY_CEILING),
            (r * self.gain).clamp(-SAFETY_CEILING, SAFETY_CEILING),
        )
    }
}

/// Telemetry snapshot published ~30 times per second.
#[derive(Clone, Copy, Debug)]
pub struct Meters {
    pub in_peak: f32,
    pub in_rms: f32,
    pub out_peak: [f32; 2],
    pub out_rms: [f32; 2],
    /// Gain reduction per insert position (dB).
    pub gr: [f32; METER_SLOTS],
    pub inserts: usize,
    pub tune: Option<TuneStatus>,
    /// Processing time / buffer time (0..1+).
    pub dsp_load: f32,
    pub dsp_load_max: f32,
    pub xruns: u32,
    /// The safety stage had to pull a bus down since the last snapshot (the signal after the
    /// faders was above [`SAFETY_CEILING`]).
    pub clipped: bool,
    /// Deepest gain reduction of the safety stage since the last snapshot, dB ≥ 0: main, monitor.
    pub safety_gr: [f32; 2],
    pub latency_probe: ProbeState,
    /// Latency of the main chain (audience / stream), samples.
    pub chain_latency_samples: u32,
    /// Latency of the chain the monitor bus hears, samples: the monitor chain while "tuned only
    /// for the audience" is on, otherwise the same figure as `chain_latency_samples`. (The dry
    /// part of the monitor blend has none.)
    pub monitor_chain_latency_samples: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ProbeState {
    Idle,
    Running,
    Done(f32),
    Failed,
}

impl Default for Meters {
    fn default() -> Self {
        Self {
            in_peak: 0.0,
            in_rms: 0.0,
            out_peak: [0.0; 2],
            out_rms: [0.0; 2],
            gr: [0.0; METER_SLOTS],
            inserts: 0,
            tune: None,
            dsp_load: 0.0,
            dsp_load_max: 0.0,
            xruns: 0,
            clipped: false,
            safety_gr: [0.0; 2],
            latency_probe: ProbeState::Idle,
            chain_latency_samples: 0,
            monitor_chain_latency_samples: 0,
        }
    }
}

/// Output of one render call.
pub struct Buses<'a> {
    pub main_l: &'a mut [f32],
    pub main_r: &'a mut [f32],
    pub mon_l: &'a mut [f32],
    pub mon_r: &'a mut [f32],
}

/// The chain of the previous scene ringing out: fed silence, fading over its tail length. The
/// main bus has one; the monitor bus has its own while a monitor chain exists, so a scene change
/// cuts no reverb in the ears that the audience still hears.
struct RingOut {
    chain: Option<Box<Chain>>,
    gain: Smoothed,
    left: usize,
}

impl RingOut {
    fn new(sample_rate: f32) -> Self {
        Self {
            chain: None,
            gain: Smoothed::with_ms(0.0, 0.0, sample_rate),
            left: 0,
        }
    }

    /// Let `old` ring out for its tail (6 s at most). A tail still ringing from the scene before
    /// is cut; a chain without a tail goes straight back.
    fn start(&mut self, old: Box<Chain>, sample_rate: f32, garbage: &mut impl FnMut(Garbage)) {
        let tail_s = old.tail_seconds().min(6.0);
        self.stop(garbage);
        if tail_s > 0.0 {
            self.left = (tail_s * sample_rate) as usize;
            self.gain.set_ramp(self.left as u32);
            self.gain.reset(1.0);
            self.gain.set(0.0);
            self.chain = Some(old);
        } else {
            garbage(Garbage::Chain(old));
        }
    }

    fn stop(&mut self, garbage: &mut impl FnMut(Garbage)) {
        if let Some(t) = self.chain.take() {
            garbage(Garbage::Chain(t));
        }
    }

    /// Add one block of the tail to `l` / `r`.
    fn add_to(&mut self, l: &mut [f32], r: &mut [f32]) {
        let Some(t) = self.chain.as_mut() else {
            return;
        };
        let n = l.len().min(r.len());
        let mut tl = [0.0f32; 256];
        let mut tr = [0.0f32; 256];
        let mut off = 0;
        while off < n {
            let m = (n - off).min(256);
            tl[..m].fill(0.0);
            tr[..m].fill(0.0);
            t.process(&mut tl[..m], &mut tr[..m]);
            for k in 0..m {
                let g = self.gain.next();
                l[off + k] += tl[k] * g;
                r[off + k] += tr[k] * g;
            }
            off += m;
        }
        self.left = self.left.saturating_sub(n);
        if self.left == 0 {
            // Finished ringing out; the box is freed when the next garbage pass runs.
            self.gain.reset(0.0);
        }
    }

    /// Rang out: the box waits for [`Core::take_finished_tail`].
    fn finished(&self) -> bool {
        self.chain.is_some() && self.left == 0
    }
}

/// Position in the monitor chain that comes right after `main_before`, the inserts in front of a
/// position in the main chain: the number of them the monitor chain has too. Both chains keep
/// the same relative order, so this skips exactly the pitch effects.
fn shared_before(mon: &Chain, main_before: &[Box<Insert>]) -> usize {
    main_before
        .iter()
        .filter(|i| mon.inserts.iter().any(|m| m.id == i.id))
        .count()
}

/// Monitor option "tuned only for the audience": a second chain (the main one minus the pitch
/// effects, same insert ids) that feeds the monitor bus. Its effects have their own state: its
/// reverb is not the main chain's reverb, it only has the same settings.
///
/// Switching the option is never a cut. On: the new chain runs unheard for
/// [`MONITOR_WARMUP_MS`], then a 10 ms crossfade moves the ears to it. Off: a 10 ms crossfade
/// back to the main chain, then the chain waits for [`Core::take_finished_tail`]. (A scene
/// change replaces both chains in the same sample, as it always did on the main bus.)
struct Monitor {
    /// `None` = the option is off: the monitor hears the main chain and nothing here costs
    /// anything.
    chain: Option<Box<Chain>>,
    /// A chain that arrived while the one before it was still fading out. It takes over, with
    /// its own warm-up, when [`Core::take_finished_tail`] collects the old one.
    next: Option<Box<Chain>>,
    /// The monitor chain of the previous scene, ringing out on the monitor bus.
    tail: RingOut,
    /// Weight of `chain` on the monitor bus: 0 = main chain, 1 = monitor chain.
    sel: Smoothed,
    /// Samples `chain` still runs unheard before the crossfade to it starts.
    warm: u32,
    warm_len: u32,
    /// Input gain of a chain switched on in the middle of a song: 0 → 1 over 10 ms, so that its
    /// delay lines do not start with a step (reasoned, not measured: an echo would repeat the
    /// step one delay time later, when the chain is heard).
    input: Smoothed,
    /// The option went off: `chain` fades out, then waits to be collected.
    retiring: bool,
}

impl Monitor {
    fn new(sample_rate: f32) -> Self {
        Self {
            chain: None,
            next: None,
            tail: RingOut::new(sample_rate),
            sel: Smoothed::with_ms(0.0, 10.0, sample_rate),
            warm: 0,
            warm_len: (MONITOR_WARMUP_MS * 0.001 * sample_rate) as u32 + 1,
            input: Smoothed::with_ms(1.0, 10.0, sample_rate),
            retiring: false,
        }
    }

    /// `chain` is processed this block: in use, warming up or fading out.
    fn running(&self) -> bool {
        self.chain.is_some() && (!self.retiring || self.sel.is_smoothing())
    }

    /// The chain that edits of the main chain must reach too: the one in use, or the one
    /// waiting to take over. None while the option is off.
    fn live(&mut self) -> Option<&mut Chain> {
        match &mut self.next {
            Some(n) => Some(n),
            None if self.retiring => None,
            None => self.chain.as_deref_mut(),
        }
    }

    fn live_ref(&self) -> Option<&Chain> {
        match &self.next {
            Some(n) => Some(n),
            None if self.retiring => None,
            None => self.chain.as_deref(),
        }
    }

    /// Stop using `chain`: 10 ms crossfade back to the main chain (nothing to fade while it
    /// was still warming up).
    fn retire(&mut self) {
        if self.chain.is_some() && !self.retiring {
            self.retiring = true;
            self.warm = 0;
            self.sel.set(0.0);
        }
    }

    /// `chain` was just put in place with empty state: run it unheard first.
    fn warm_up(&mut self) {
        self.retiring = false;
        self.sel.reset(0.0);
        self.warm = self.warm_len;
        self.input.reset(0.0);
        self.input.set(1.0);
    }

    fn drop_next(&mut self, garbage: &mut impl FnMut(Garbage)) {
        if let Some(n) = self.next.take() {
            garbage(Garbage::Chain(n));
        }
    }

    /// The option was switched on with `chain`.
    fn switch_on(&mut self, chain: Box<Chain>, garbage: &mut impl FnMut(Garbage)) {
        self.drop_next(garbage);
        if self.chain.is_some() && (self.sel.value() > 0.0 || self.sel.is_smoothing()) {
            // The ears are (partly) on the old chain: off and on again within 10 ms, or a host
            // that sent "on" twice. It fades out first; the new one waits its turn.
            self.retire();
            self.next = Some(chain);
        } else {
            // None, or one nobody hears (warming up, or waiting to be collected).
            if let Some(old) = self.chain.replace(chain) {
                garbage(Garbage::Chain(old));
            }
            self.tail.stop(garbage);
            self.warm_up();
        }
    }

    /// A scene change that brought its monitor chain.
    fn swap(&mut self, chain: Box<Chain>, sample_rate: f32, garbage: &mut impl FnMut(Garbage)) {
        self.drop_next(garbage);
        if self.retiring && self.running() {
            // Still fading out of the old scene's chain: the new one waits its turn.
            self.next = Some(chain);
            return;
        }
        // The ears are on the monitor chain alone (not warming up, not in a crossfade).
        let settled =
            self.chain.is_some() && !self.retiring && self.warm == 0 && !self.sel.is_smoothing();
        match self.chain.replace(chain) {
            // The old monitor chain rings out on the monitor bus, as the old main chain does on
            // the main bus. (One the ears were not on yet has no tail they should hear.)
            Some(old) if settled => self.tail.start(old, sample_rate, garbage),
            Some(old) => garbage(Garbage::Chain(old)),
            None => {}
        }
        self.retiring = false;
        // The new monitor chain starts as hard as the new main chain does.
        self.input.reset(1.0);
        if self.warm > 0 {
            // The option was switched on a moment ago: the warm-up starts again.
            self.warm = self.warm_len;
        } else if self.sel.is_smoothing() {
            // ... and the crossfade to it had started: it goes on.
            self.sel.set(1.0);
        } else {
            self.sel.reset(1.0);
        }
    }

    /// Weight of `chain` for the next sample (counts the warm-up down, runs the crossfade).
    #[inline]
    fn weight(&mut self) -> f32 {
        if self.warm > 0 {
            self.warm -= 1;
            if self.warm == 0 {
                self.sel.set(1.0);
            }
        }
        self.sel.next()
    }

    /// A chain nobody hears any more, one per call; the chain that waited takes over.
    fn collect(&mut self) -> Option<Box<Chain>> {
        let running = self.running();
        if self.tail.finished() || (self.tail.chain.is_some() && !running) {
            return self.tail.chain.take();
        }
        if self.retiring && !running {
            let old = self.chain.take();
            self.retiring = false;
            if let Some(next) = self.next.take() {
                self.chain = Some(next);
                self.warm_up();
            }
            return old;
        }
        None
    }
}

pub struct Core {
    sr: f32,
    max_block: usize,
    chain: Box<Chain>,
    tail: RingOut,
    mon: Monitor,
    /// Working L/R, dry L/R, monitor-chain L/R.
    scratch: [Vec<f32>; 6],
    in_gain: Smoothed,
    main_gain: Smoothed,
    mon_gain: Smoothed,
    mon_dry: Smoothed,
    bypass: Smoothed,
    mute: Smoothed,
    /// Main, monitor.
    safety: [Safety; 2],
    gain_ramp: [u32; 2],
    probe: LatencyProbe,
    probe_out: Vec<f32>,
    // meter accumulation
    acc_in_peak: f32,
    acc_in_sq: f64,
    acc_out_peak: [f32; 2],
    acc_out_sq: [f64; 2],
    acc_safety_min: [f32; 2],
    acc_n: usize,
    publish_every: usize,
    clipped: bool,
    pub xruns: u32,
    pub dsp_load: f32,
    pub dsp_load_max: f32,
}

impl Core {
    pub fn new(sample_rate: f32, max_block: usize) -> Self {
        let ramp = |v| Smoothed::with_ms(v, 10.0, sample_rate);
        Self {
            sr: sample_rate,
            max_block,
            chain: Box::default(),
            tail: RingOut::new(sample_rate),
            mon: Monitor::new(sample_rate),
            scratch: core::array::from_fn(|_| vec![0.0; max_block]),
            in_gain: ramp(1.0),
            main_gain: ramp(1.0),
            mon_gain: ramp(1.0),
            mon_dry: ramp(0.0),
            bypass: ramp(0.0),
            mute: ramp(1.0),
            safety: [Safety::new(sample_rate), Safety::new(sample_rate)],
            gain_ramp: [
                (GAIN_DOWN_MS * 0.001 * sample_rate) as u32,
                (GAIN_UP_MS * 0.001 * sample_rate) as u32,
            ],
            probe: LatencyProbe::new(sample_rate),
            probe_out: vec![0.0; max_block],
            acc_in_peak: 0.0,
            acc_in_sq: 0.0,
            acc_out_peak: [0.0; 2],
            acc_out_sq: [0.0; 2],
            acc_safety_min: [1.0; 2],
            acc_n: 0,
            publish_every: (sample_rate / 30.0) as usize,
            clipped: false,
            xruns: 0,
            dsp_load: 0.0,
            dsp_load_max: 0.0,
        }
    }

    pub fn sample_rate(&self) -> f32 {
        self.sr
    }

    pub fn max_block(&self) -> usize {
        self.max_block
    }

    pub fn chain(&self) -> &Chain {
        &self.chain
    }

    /// The chain that feeds the monitor bus while "tuned only for the audience" is on (from the
    /// moment the option is switched on: it may still be warming up).
    pub fn monitor_chain(&self) -> Option<&Chain> {
        self.mon.live_ref()
    }

    /// A monitor chain was just switched on and has not processed a sample yet (tests start
    /// their reference engine at this moment).
    #[cfg(test)]
    pub(crate) fn monitor_fresh(&self) -> bool {
        self.mon.chain.is_some() && !self.mon.retiring && self.mon.warm == self.mon.warm_len
    }

    /// Apply one command. `garbage` receives boxes that must be freed off the audio thread.
    pub fn apply(&mut self, cmd: Command, garbage: &mut impl FnMut(Garbage)) {
        let [down, up] = self.gain_ramp;
        let fade = |s: &mut Smoothed, db: f32| {
            let target = db_to_lin(db);
            // Against the value the gain has NOW: a fader that overshoots and settles is
            // retargeted in the middle of a rise, and that rise must stay slow.
            s.set_ramp(if target > s.value() { up } else { down });
            s.set(target);
        };
        match cmd {
            Command::SetParam {
                insert,
                index,
                value,
            } => {
                if let Some(i) = self.chain.find_mut(insert) {
                    i.fx.set_param(index, value);
                }
                if let Some(i) = self.mon.live().and_then(|m| m.find_mut(insert)) {
                    i.fx.set_param(index, value);
                }
            }
            Command::SetEnabled { insert, on } => {
                if let Some(i) = self.chain.find_mut(insert) {
                    i.set_enabled(on);
                }
                if let Some(i) = self.mon.live().and_then(|m| m.find_mut(insert)) {
                    i.set_enabled(on);
                }
            }
            Command::AddInsert { at, insert } => {
                if let Err(back) = self.chain.try_insert(at, insert) {
                    garbage(Garbage::Insert(back));
                }
            }
            Command::AddInsertBoth {
                at,
                insert,
                monitor,
            } => {
                // The inserts in front of the new one are the same before and after it goes in.
                let before = at.min(self.chain.inserts.len());
                match self.chain.try_insert(at, insert) {
                    Err(back) => {
                        garbage(Garbage::Insert(back));
                        garbage(Garbage::Insert(monitor));
                    }
                    Ok(()) => match self.mon.live() {
                        Some(m) if !is_pitch_fx(monitor.kind) => {
                            let mon_at = shared_before(m, &self.chain.inserts[..before]);
                            if let Err(back) = m.try_insert(mon_at, monitor) {
                                garbage(Garbage::Insert(back));
                            }
                        }
                        // No monitor chain (any more), or a pitch effect that must not be in it.
                        _ => garbage(Garbage::Insert(monitor)),
                    },
                }
            }
            Command::RemoveInsert { insert } => {
                if let Some(b) = self.chain.remove(insert) {
                    garbage(Garbage::Insert(b));
                }
                if let Some(b) = self.mon.live().and_then(|m| m.remove(insert)) {
                    garbage(Garbage::Insert(b));
                }
            }
            Command::MoveInsert { insert, to } => {
                if self.chain.move_to(insert, to)
                    && let Some(m) = self.mon.live()
                    && let Some(now_at) = self.chain.inserts.iter().position(|x| x.id == insert)
                {
                    // `to` counts the pitch effects too; the monitor chain does not have them.
                    let mon_to = shared_before(m, &self.chain.inserts[..now_at]);
                    m.move_to(insert, mon_to);
                }
            }
            Command::SwapChain { chain } => {
                let old = core::mem::replace(&mut self.chain, chain);
                self.tail.start(old, self.sr, garbage);
                // The new scene came without a monitor chain and none can be built here.
                self.mon.drop_next(garbage);
                self.mon.retire();
            }
            Command::SwapChains { chain, monitor } => {
                let old = core::mem::replace(&mut self.chain, chain);
                self.tail.start(old, self.sr, garbage);
                self.mon.swap(monitor, self.sr, garbage);
            }
            Command::SetMonitorChain { chain: Some(chain) } => {
                self.mon.switch_on(chain, garbage);
            }
            Command::SetMonitorChain { chain: None } => {
                self.mon.drop_next(garbage);
                self.mon.retire();
            }
            Command::InputGain(db) => fade(&mut self.in_gain, db),
            Command::MainGain(db) => fade(&mut self.main_gain, db),
            Command::MonitorGain(db) => fade(&mut self.mon_gain, db),
            Command::MonitorDry(x) => self.mon_dry.set(x.clamp(0.0, 1.0)),
            Command::Bypass(on) => self.bypass.set(if on { 1.0 } else { 0.0 }),
            Command::Mute(on) => self.mute.set(if on { 0.0 } else { 1.0 }),
            Command::StartLatencyProbe => self.probe.start(),
            Command::Reset => {
                self.chain.reset();
                self.tail.stop(garbage);
                for m in [&mut self.mon.chain, &mut self.mon.next]
                    .into_iter()
                    .flatten()
                {
                    m.reset();
                }
                self.mon.tail.stop(garbage);
            }
        }
    }

    /// Process one block. `input_l/r` hold the input (mono sources pass the same slice twice
    /// via copy before calling). Every slice has the same length `<= max_block`.
    pub fn render(&mut self, input_l: &[f32], input_r: &[f32], out: Buses<'_>) {
        // Flush-to-zero for the whole block (restored on return): states decaying into silence
        // must reach zero instead of parking in the subnormal range.
        let _flush = live_dsp::NoDenormals::enter();
        let n = input_l.len().min(self.max_block);
        let mon_on = self.mon.running();
        let [wl, wr, dl, dr, xl, xr] = &mut self.scratch;
        let (wl, wr, dl, dr) = (&mut wl[..n], &mut wr[..n], &mut dl[..n], &mut dr[..n]);
        let (xl, xr) = (&mut xl[..n], &mut xr[..n]);
        let probing = self.probe.phase() == Phase::Running;
        for i in 0..n {
            let g = self.in_gain.next();
            // One NaN from a driver would otherwise poison every envelope follower downstream.
            let clean = |x: f32| if x.is_finite() { x } else { 0.0 };
            let (a, b) = (clean(input_l[i]) * g, clean(input_r[i]) * g);
            let pk = a.abs().max(b.abs());
            if probing {
                self.probe_out[i] = self.probe.tick(pk);
            }
            self.acc_in_peak = self.acc_in_peak.max(pk);
            self.acc_in_sq += (0.5 * (a * a + b * b)) as f64;
            wl[i] = a;
            wr[i] = b;
            dl[i] = a;
            dr[i] = b;
        }
        if mon_on {
            // The monitor chain gets the same input as the main chain (faded in when the chain
            // was switched on a moment ago).
            if self.mon.input.is_smoothing() {
                for i in 0..n {
                    let g = self.mon.input.next();
                    xl[i] = wl[i] * g;
                    xr[i] = wr[i] * g;
                }
            } else {
                xl.copy_from_slice(wl);
                xr.copy_from_slice(wr);
            }
        }
        self.chain.process(wl, wr);
        // Ring out the previous scene's tails, fed silence, fading over the tail length.
        self.tail.add_to(wl, wr);
        if mon_on {
            if let Some(m) = self.mon.chain.as_mut() {
                m.process(xl, xr);
            }
            // The previous scene's monitor chain rings out here, not the main one: the ears get
            // the tail of what they were hearing.
            self.mon.tail.add_to(xl, xr);
        }
        for i in 0..n {
            let byp = self.bypass.next();
            let mute = self.mute.next();
            let pl = wl[i] + byp * (dl[i] - wl[i]);
            let pr = wr[i] + byp * (dr[i] - wr[i]);
            let mg = self.main_gain.next() * mute;
            let md = self.mon_dry.next();
            let mo = self.mon_gain.next() * mute;
            let probe = if probing { self.probe_out[i] } else { 0.0 };
            let (ml, mr) = self.safety[0].tick(pl * mg + probe, pr * mg + probe);
            // What the monitor hears before its dry blend: the main bus signal, or the monitor
            // chain (crossfaded in and out over 10 ms), with the same bypass.
            let (ql, qr) = if mon_on {
                let sel = self.mon.weight();
                // Exact at both ends: the monitor chain alone, or the main chain alone.
                let (cl, cr) = if sel >= 1.0 {
                    (xl[i], xr[i])
                } else if sel <= 0.0 {
                    (wl[i], wr[i])
                } else {
                    (wl[i] + sel * (xl[i] - wl[i]), wr[i] + sel * (xr[i] - wr[i]))
                };
                (cl + byp * (dl[i] - cl), cr + byp * (dr[i] - cr))
            } else {
                (pl, pr)
            };
            let (ol, or) = self.safety[1].tick(
                (ql + md * (dl[i] - ql)) * mo + probe,
                (qr + md * (dr[i] - qr)) * mo + probe,
            );
            out.main_l[i] = ml;
            out.main_r[i] = mr;
            out.mon_l[i] = ol;
            out.mon_r[i] = or;
            for (acc, s) in self.acc_safety_min.iter_mut().zip(&self.safety) {
                *acc = acc.min(s.gain);
            }
            let (al, ar) = (ml.abs(), mr.abs());
            self.acc_out_peak[0] = self.acc_out_peak[0].max(al);
            self.acc_out_peak[1] = self.acc_out_peak[1].max(ar);
            self.acc_out_sq[0] += (ml * ml) as f64;
            self.acc_out_sq[1] += (mr * mr) as f64;
        }
        self.acc_n += n;
    }

    /// Hand back a chain that is no longer heard (call after `render`, outside the hot loop):
    /// a tail that rang out on either bus, or the monitor chain after the option went off.
    /// One box per call. A monitor chain that arrived while the one before it was still fading
    /// out takes over here, so a host that switches the monitor option must call this.
    pub fn take_finished_tail(&mut self) -> Option<Box<Chain>> {
        if self.tail.finished() {
            return self.tail.chain.take();
        }
        self.mon.collect()
    }

    /// Returns a meters snapshot when one is due (every ~33 ms of audio).
    pub fn meters_due(&mut self) -> Option<Meters> {
        if self.acc_n < self.publish_every {
            return None;
        }
        let n = self.acc_n.max(1) as f64;
        // 0.1 dB of reduction counts as "the safety stage is working".
        let gr = self.acc_safety_min.map(|g| -20.0 * g.max(1e-6).log10());
        self.clipped = gr.iter().any(|d| *d > 0.1);
        let mut m = Meters {
            in_peak: self.acc_in_peak,
            in_rms: (self.acc_in_sq / n).sqrt() as f32,
            out_peak: self.acc_out_peak,
            out_rms: [
                (self.acc_out_sq[0] / n).sqrt() as f32,
                (self.acc_out_sq[1] / n).sqrt() as f32,
            ],
            inserts: self.chain.inserts.len(),
            dsp_load: self.dsp_load,
            dsp_load_max: self.dsp_load_max,
            xruns: self.xruns,
            clipped: self.clipped,
            safety_gr: gr,
            chain_latency_samples: self.chain.latency() as u32,
            // The chain the ears are on (or moving to); the main chain until a new monitor chain
            // has warmed up.
            monitor_chain_latency_samples: match self.mon.chain.as_deref() {
                Some(m) if self.mon.sel.target() >= 1.0 => m.latency(),
                _ => self.chain.latency(),
            } as u32,
            latency_probe: match self.probe.phase() {
                Phase::Idle => ProbeState::Idle,
                Phase::Running => ProbeState::Running,
                Phase::Done { .. } => ProbeState::Done(self.probe.result_ms().unwrap_or(0.0)),
                Phase::Failed => ProbeState::Failed,
            },
            ..Meters::default()
        };
        for (slot, ins) in m.gr.iter_mut().zip(self.chain.inserts.iter()) {
            *slot = if ins.enabled() {
                ins.fx.gain_reduction_db()
            } else {
                0.0
            };
            if m.tune.is_none() && ins.enabled() {
                m.tune = ins.fx.tune_status();
            }
        }
        self.acc_in_peak = 0.0;
        self.acc_in_sq = 0.0;
        self.acc_out_peak = [0.0; 2];
        self.acc_out_sq = [0.0; 2];
        self.acc_safety_min = [1.0; 2];
        self.acc_n = 0;
        self.clipped = false;
        self.dsp_load_max = 0.0;
        Some(m)
    }
}

/// Test bookkeeping: every chain and insert box handed to the audio thread, and every one it
/// gave back (through the garbage callback or [`Core::take_finished_tail`]). A box dropped on
/// the audio thread, or kept for ever, breaks [`Ledger::assert_balanced`].
#[cfg(test)]
pub(crate) struct Ledger {
    pub chains_in: usize,
    pub chains_out: usize,
    /// Inserts sent on their own or inside a chain.
    pub inserts_in: usize,
    pub inserts_out: usize,
}

#[cfg(test)]
impl Ledger {
    /// Start counting from what `core` holds now.
    pub fn for_core(core: &Core) -> Self {
        let (chains_in, inserts_in) = Self::held(core);
        Self {
            chains_in,
            chains_out: 0,
            inserts_in,
            inserts_out: 0,
        }
    }

    /// Chains `core` holds (main, monitor, the one waiting to become the monitor chain, the two
    /// tails) and the inserts in them.
    fn held(core: &Core) -> (usize, usize) {
        let held = [
            Some(&*core.chain),
            core.mon.chain.as_deref(),
            core.mon.next.as_deref(),
            core.tail.chain.as_deref(),
            core.mon.tail.chain.as_deref(),
        ];
        (
            held.iter().flatten().count(),
            held.iter().flatten().map(|c| c.inserts.len()).sum(),
        )
    }

    fn chain_in(&mut self, c: &Chain) {
        self.chains_in += 1;
        self.inserts_in += c.inserts.len();
    }

    pub fn apply(&mut self, core: &mut Core, cmd: Command) {
        match &cmd {
            Command::SwapChain { chain } | Command::SetMonitorChain { chain: Some(chain) } => {
                self.chain_in(chain);
            }
            Command::SwapChains { chain, monitor } => {
                self.chain_in(chain);
                self.chain_in(monitor);
            }
            Command::AddInsert { .. } => self.inserts_in += 1,
            Command::AddInsertBoth { .. } => self.inserts_in += 2,
            _ => {}
        }
        core.apply(cmd, &mut |g| self.back(g));
    }

    pub fn back(&mut self, g: Garbage) {
        match g {
            Garbage::Chain(c) => {
                self.chains_out += 1;
                self.inserts_out += c.inserts.len();
            }
            Garbage::Insert(_) => self.inserts_out += 1,
        }
    }

    /// What a host does after every `render`.
    pub fn collect(&mut self, core: &mut Core) {
        if let Some(t) = core.take_finished_tail() {
            self.back(Garbage::Chain(t));
        }
    }

    /// Everything that is not back is still in use inside `core`: its main chain, its monitor
    /// chain and the tails that are still ringing.
    pub fn assert_balanced(&self, core: &Core) {
        let (chains, inserts) = Self::held(core);
        assert_eq!(
            (self.chains_in, self.inserts_in),
            (self.chains_out + chains, self.inserts_out + inserts),
            "boxes sent to the audio thread vs boxes back + boxes it holds \
             (chains, inserts): out {} + held {chains}, out {} + held {inserts}",
            self.chains_out,
            self.inserts_out,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::preset::factory;

    fn sine(f: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| 0.3 * (core::f32::consts::TAU * f * i as f32 / 48000.0).sin())
            .collect()
    }

    fn render_block(core: &mut Core, inp: &[f32]) -> (Vec<f32>, Vec<f32>) {
        let n = inp.len();
        let (mut ml, mut mr, mut ol, mut or) =
            (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
        core.render(
            inp,
            inp,
            Buses {
                main_l: &mut ml,
                main_r: &mut mr,
                mon_l: &mut ol,
                mon_r: &mut or,
            },
        );
        (ml, ol)
    }

    #[test]
    fn scene_swap_is_click_free_and_rings_out() {
        let mut core = Core::new(48000.0, 128);
        let mut g = |_g: Garbage| {};
        let a = factory()
            .into_iter()
            .find(|p| p.name == "Ballad Hall")
            .unwrap()
            .build(48000.0, 128, 1)
            .unwrap();
        core.apply(Command::SwapChain { chain: a.chain }, &mut g);
        let input = sine(220.0, 48000);
        let mut out = Vec::new();
        for (k, blk) in input.chunks(128).enumerate() {
            if k == 200 {
                let b = factory()[6].build(48000.0, 128, 100).unwrap(); // Speech: no reverb
                core.apply(Command::SwapChain { chain: b.chain }, &mut g);
            }
            out.extend(render_block(&mut core, blk).0);
        }
        assert!(out.iter().all(|x| x.is_finite()));
        let max_step = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max);
        assert!(max_step < 0.25, "step {max_step}");
        assert!(
            core.tail.chain.is_some(),
            "hall tail should still ring 1 s after the swap"
        );
    }

    #[test]
    fn bypass_and_monitor_dry() {
        let mut core = Core::new(48000.0, 64);
        let mut g = |_g: Garbage| {};
        let p = factory()
            .into_iter()
            .find(|p| p.name == "Rock Grit")
            .unwrap()
            .build(48000.0, 64, 1)
            .unwrap();
        core.apply(Command::SwapChain { chain: p.chain }, &mut g);
        core.apply(Command::MonitorDry(1.0), &mut g);
        core.apply(Command::Bypass(false), &mut g);
        let input = sine(330.0, 64);
        for _ in 0..100 {
            render_block(&mut core, &input);
        }
        let (_main, mon) = render_block(&mut core, &input);
        for (a, b) in mon.iter().zip(&input) {
            assert!((a - b).abs() < 1e-4, "monitor should be dry");
        }
    }

    #[test]
    fn meters_publish_at_30hz() {
        let mut core = Core::new(48000.0, 128);
        let input = sine(440.0, 128);
        let mut published = 0;
        for _ in 0..375 {
            render_block(&mut core, &input);
            if core.meters_due().is_some() {
                published += 1;
            }
        }
        // 1600-sample interval rounded up to whole 128-frame blocks = 1664 → 28.8 Hz.
        assert!((28..=31).contains(&published), "{published}");
    }

    fn render_all(core: &mut Core, input: &[f32], block: usize) -> (Vec<f32>, Vec<f32>) {
        let (mut main, mut mon) = (Vec::new(), Vec::new());
        for blk in input.chunks(block) {
            let (a, b) = render_block(core, blk);
            main.extend(a);
            mon.extend(b);
        }
        (main, mon)
    }

    /// Every fader at +12 dB on a full-scale input, processed and bypassed, with and without a
    /// chain: neither bus may ever exceed the ceiling, and the meters must say the stage worked.
    #[test]
    fn no_bus_exceeds_the_safety_ceiling() {
        let hot: Vec<f32> = (0..48000)
            .map(|i| (core::f32::consts::TAU * 220.0 * i as f32 / 48000.0).sin())
            .collect();
        for with_chain in [false, true] {
            for bypass in [false, true] {
                let mut core = Core::new(48000.0, 128);
                let mut g = |_g: Garbage| {};
                if with_chain {
                    let p = factory()[0].build(48000.0, 128, 1).unwrap();
                    core.apply(Command::SwapChain { chain: p.chain }, &mut g);
                }
                core.apply(Command::InputGain(12.0), &mut g);
                core.apply(Command::MainGain(12.0), &mut g);
                core.apply(Command::MonitorGain(12.0), &mut g);
                core.apply(Command::MonitorDry(0.5), &mut g);
                core.apply(Command::Bypass(bypass), &mut g);
                let mut worst = [0.0f32; 2];
                let mut engaged = false;
                for blk in hot.chunks(128) {
                    let (main, mon) = render_block(&mut core, blk);
                    worst[0] = main.iter().fold(worst[0], |m, v| m.max(v.abs()));
                    worst[1] = mon.iter().fold(worst[1], |m, v| m.max(v.abs()));
                    if let Some(m) = core.meters_due() {
                        engaged |= m.clipped && m.safety_gr.iter().any(|d| *d > 1.0);
                    }
                }
                assert!(
                    worst.iter().all(|w| *w <= SAFETY_CEILING),
                    "chain {with_chain} bypass {bypass}: peaks {worst:?}"
                );
                assert!(engaged, "chain {with_chain} bypass {bypass}: no reduction");
            }
        }
    }

    #[test]
    fn safety_stage_is_transparent_below_the_ceiling() {
        let mut core = Core::new(48000.0, 128);
        let input = sine(330.0, 4800); // 0.3 peak, no chain
        let (main, mon) = render_all(&mut core, &input, 128);
        for ((a, b), x) in main.iter().zip(&mon).zip(&input) {
            assert!((a - x).abs() < 1e-6 && (b - x).abs() < 1e-6);
        }
        let m = core.meters_due().unwrap();
        assert!(!m.clipped && m.safety_gr == [0.0, 0.0], "{m:?}");
    }

    /// A fader moved up takes ~300 ms to arrive; moved down, 10 ms.
    #[test]
    fn faders_rise_slowly_and_fall_fast() {
        let mut core = Core::new(48000.0, 128);
        let mut g = |_g: Garbage| {};
        let dc = vec![0.1f32; 128];
        core.apply(Command::MainGain(12.0), &mut g);
        let first = render_block(&mut core, &dc).0;
        // 128 samples into a 14 400-sample ramp from 1.0 to 3.98: about +0.03 of gain.
        assert!(first[127] < 0.1 * 1.05, "rose too fast: {}", first[127]);
        for _ in 0..120 {
            render_block(&mut core, &dc);
        }
        let top = render_block(&mut core, &dc).0[127];
        assert!((top - 0.1 * 3.981).abs() < 1e-3, "{top}");
        core.apply(Command::MainGain(-60.0), &mut g);
        for _ in 0..4 {
            render_block(&mut core, &dc);
        }
        let low = render_block(&mut core, &dc).0[127];
        assert!(low < 0.1 * 0.002, "fell too slowly: {low}");
    }

    /// A fader that overshoots and settles (+12 dB, then +8 dB 100 ms later) is retargeted while
    /// the gain is still below the new target: the rest of the rise must stay slow. Comparing
    /// with the previous target instead of the current value finished it in 10 ms.
    #[test]
    fn a_retargeted_rise_stays_slow() {
        let mut core = Core::new(48000.0, 128);
        let mut g = |_g: Garbage| {};
        let dc = vec![0.1f32; 128];
        core.apply(Command::MainGain(12.0), &mut g);
        let mut out = Vec::new();
        for _ in 0..38 {
            out.extend(render_block(&mut core, &dc).0); // ~101 ms: gain about 2.0 of 3.98
        }
        let at_retarget = *out.last().unwrap() / 0.1;
        assert!(at_retarget > 1.5 && at_retarget < 2.4, "{at_retarget}");
        core.apply(Command::MainGain(8.0), &mut g); // 2.51: still above the current gain
        for _ in 0..120 {
            out.extend(render_block(&mut core, &dc).0);
        }
        // Fastest rise allowed anywhere: the whole 0 → +12 dB move spread over 300 ms.
        let limit = 0.1 * (3.982 - 1.0) / (0.3 * 48000.0) * 1.05;
        let steepest = out.windows(2).map(|w| w[1] - w[0]).fold(0.0f32, f32::max);
        assert!(steepest <= limit, "rise per sample {steepest} > {limit}");
        let end = *out.last().unwrap() / 0.1;
        assert!((end - 2.512).abs() < 1e-2, "{end}");
    }

    /// When the input stops, filter and reverb states decay towards zero. Without flush-to-zero
    /// they park in the subnormal range and every later operation on them runs in microcode
    /// (measured: silence cost 11–27× more CPU than a dithered file). No bus may carry a
    /// subnormal sample.
    ///
    /// The tail does not have to be exactly zero: measured on Speech / MC it settles at 1e-37
    /// (the same value after 30 s and after 40 s). That is a normal float, so it costs nothing,
    /// and it is what flush-to-zero does to a one-pole state: once its update is smaller than
    /// the smallest normal float the update flushes to zero and the state stops moving
    /// (`live_dsp::denormal` has the arithmetic as a test).
    #[test]
    fn silence_after_a_signal_leaves_no_subnormals() {
        if !cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
            return; // the guard is a no-op elsewhere (see live_dsp::denormal)
        }
        // (preset, the tail must be below 1e-30 = −600 dBFS at the end). The 4 s hall is still
        // ringing after 30 s, so only "no subnormals" is asked of it.
        // Every preset is judged before the test fails, so one red run shows all of them.
        let mut problems = Vec::new();
        for (preset, quiet_tail) in [("Ballad Hall", false), ("Speech / MC", true)] {
            let mut core = Core::new(48000.0, 128);
            let p = factory()
                .into_iter()
                .find(|p| p.name == preset)
                .unwrap()
                .build(48000.0, 128, 1)
                .unwrap();
            core.apply(Command::SwapChain { chain: p.chain }, &mut |_g| {});
            let mut input = sine(220.0, 24000);
            input.extend(core::iter::repeat_n(0.0f32, 30 * 48000));
            let (main, mon) = render_all(&mut core, &input, 128);
            let subnormal = main.iter().chain(&mon).filter(|v| v.is_subnormal()).count();
            if subnormal > 0 {
                problems.push(format!("{preset}: {subnormal} subnormal output samples"));
            }
            if quiet_tail {
                let tail = &main[main.len() - 4800..];
                let worst = tail.iter().fold(0.0f32, |m, v| m.max(v.abs()));
                if worst >= 1e-30 {
                    problems.push(format!("{preset}: tail at {worst:e} after 30 s"));
                }
            }
        }
        assert!(problems.is_empty(), "{problems:?}");
    }

    /// One non-finite input sample is dropped: it reaches no bus and the chain keeps working.
    #[test]
    fn non_finite_input_is_dropped_and_the_chain_recovers() {
        for preset in ["Natural Vocal", "Rock Grit", "Speech / MC"] {
            let build = || {
                let mut core = Core::new(48000.0, 128);
                let p = factory()
                    .into_iter()
                    .find(|p| p.name == preset)
                    .unwrap()
                    .build(48000.0, 128, 1)
                    .unwrap();
                core.apply(Command::SwapChain { chain: p.chain }, &mut |_g| {});
                core
            };
            let clean = sine(220.0, 96000);
            let mut dirty = clean.clone();
            dirty[48000] = f32::NAN;
            dirty[48001] = f32::INFINITY;
            let (want, _) = render_all(&mut build(), &clean, 128);
            let (got, mon) = render_all(&mut build(), &dirty, 128);
            assert!(got.iter().chain(&mon).all(|v| v.is_finite()), "{preset}");
            let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
            let (a, b) = (rms(&want[72000..]), rms(&got[72000..]));
            assert!(
                (20.0 * (b / a).log10()).abs() < 0.5,
                "{preset}: level after the bad sample {b} vs {a}"
            );
        }
    }

    #[test]
    fn render_does_not_allocate() {
        let mut core = Core::new(48000.0, 128);
        let mut g = |_g: Garbage| {};
        let p = factory()[3].build(48000.0, 128, 1).unwrap();
        core.apply(Command::SwapChain { chain: p.chain }, &mut g);
        let input = sine(440.0, 128);
        let (mut ml, mut mr, mut ol, mut or) = (
            vec![0.0; 128],
            vec![0.0; 128],
            vec![0.0; 128],
            vec![0.0; 128],
        );
        let next = factory()[0].build(48000.0, 128, 50).unwrap().chain;
        let mut kept = Vec::with_capacity(4);
        assert_no_alloc::assert_no_alloc(|| {
            let mut sink = |x: Garbage| kept.push(x);
            for k in 0..400 {
                if k == 100 {
                    core.apply(Command::SwapChain { chain: next }, &mut sink);
                    break;
                }
                core.render(
                    &input,
                    &input,
                    Buses {
                        main_l: &mut ml,
                        main_r: &mut mr,
                        mon_l: &mut ol,
                        mon_r: &mut or,
                    },
                );
                let _ = core.meters_due();
            }
            for _ in 0..300 {
                core.render(
                    &input,
                    &input,
                    Buses {
                        main_l: &mut ml,
                        main_r: &mut mr,
                        mon_l: &mut ol,
                        mon_r: &mut or,
                    },
                );
                let _ = core.meters_due();
            }
        });
    }

    // ─── Monitor option "tuned only for the audience" ───────────────────────

    fn preset(name: &str) -> crate::preset::Preset {
        factory().into_iter().find(|p| p.name == name).unwrap()
    }

    /// The preset without its pitch effects, same insert ids as `preset(name).build(.., first_id)`.
    /// Filters by effect id on purpose, not with `is_pitch_fx`: the tests must not share the
    /// list they check.
    fn untuned_chain(name: &str, first_id: u32) -> Box<Chain> {
        let full = preset(name).build(48000.0, 128, first_id).unwrap().chain;
        let mut out = Box::<Chain>::default();
        let pitch = |i: &Insert| ["autotune", "harmonizer"].contains(&i.kind.id());
        for ins in full.inserts.into_iter().filter(|i| !pitch(i)) {
            let at = out.inserts.len();
            out.try_insert(at, ins).ok().unwrap();
        }
        out
    }

    fn core_with(name: &str, untuned: bool) -> Core {
        let mut core = Core::new(48000.0, 128);
        let chain = preset(name).build(48000.0, 128, 1).unwrap().chain;
        if untuned {
            let monitor = untuned_chain(name, 1);
            core.apply(Command::SwapChains { chain, monitor }, &mut |_g| {});
        } else {
            core.apply(Command::SwapChain { chain }, &mut |_g| {});
        }
        core
    }

    /// A voice-like test signal: a tone with harmonics at 226 Hz, 47 cents above A3, so the
    /// autotune has a pitch to lock on and something to correct.
    fn voice(n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| {
                let t = i as f32 / 48000.0;
                let w = core::f32::consts::TAU * 226.0 * t;
                0.2 * w.sin() + 0.1 * (2.0 * w).sin() + 0.05 * (3.0 * w).sin()
            })
            .collect()
    }

    /// Index of the first sample that is not silence.
    fn onset(x: &[f32]) -> Option<usize> {
        x.iter().position(|v| v.abs() > 1e-4)
    }

    fn max_step(x: &[f32]) -> f32 {
        x.windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0, f32::max)
    }

    /// Off: both buses are what they are without the option (a plain `SwapChain`, never
    /// toggled), bit for bit, on a preset with pitch correction — before the option is switched
    /// on and again once it is off. The main bus never changes at all.
    #[test]
    fn untuned_off_is_bit_identical_to_a_plain_swap() {
        let input = voice(48000);
        let (main_a, mon_a) = render_all(&mut core_with("Pop Polish", false), &input, 128);
        assert_eq!(main_a, mon_a, "off: the monitor carries the main chain");
        let mut core = core_with("Pop Polish", false);
        let mut ledger = Ledger::for_core(&core);
        let (mut main_b, mut mon_b) = (Vec::new(), Vec::new());
        // On at 100 blocks, off at 200 blocks (plus the 10 ms = 480 sample fade).
        let (on_at, off_at) = (100 * 128, 200 * 128);
        for (k, blk) in input.chunks(128).enumerate() {
            if k * 128 == on_at {
                let chain = Some(untuned_chain("Pop Polish", 1));
                ledger.apply(&mut core, Command::SetMonitorChain { chain });
            }
            if k * 128 == off_at {
                ledger.apply(&mut core, Command::SetMonitorChain { chain: None });
            }
            let (a, b) = render_block(&mut core, blk);
            main_b.extend(a);
            mon_b.extend(b);
            ledger.collect(&mut core);
        }
        assert_eq!(main_a, main_b, "main bus must not depend on the option");
        assert_eq!(
            &mon_a[..on_at],
            &mon_b[..on_at],
            "monitor before the option"
        );
        // Switched on, the new chain first runs unheard for 50 ms (2400 samples).
        assert_eq!(
            &mon_a[on_at..on_at + 2400],
            &mon_b[on_at..on_at + 2400],
            "monitor during the warm-up"
        );
        assert_eq!(
            &mon_a[off_at + 480..],
            &mon_b[off_at + 480..],
            "monitor after the fade must be the main chain again"
        );
        assert_ne!(
            &mon_a[on_at + 2400..on_at + 2880],
            &mon_b[on_at + 2400..on_at + 2880],
            "the crossfade starts after the warm-up"
        );
        // The monitor chain came back and nothing but the main chain is left: no cost when off.
        ledger.assert_balanced(&core);
        assert_eq!(ledger.chains_out, 1, "the monitor chain came back");
        assert!(core.mon.chain.is_none() && core.mon.tail.chain.is_none());
    }

    /// On: the main bus is unchanged sample for sample and the monitor bus is what the same
    /// preset without the pitch inserts produces on the MAIN bus.
    #[test]
    fn untuned_monitor_is_the_chain_without_the_pitch_inserts() {
        for name in ["Pop Polish", "Harmony Stack"] {
            let input = voice(48000);
            let (main_off, _) = render_all(&mut core_with(name, false), &input, 128);
            let (main_on, mon_on) = render_all(&mut core_with(name, true), &input, 128);
            assert_eq!(main_off, main_on, "{name}: main bus changed");
            // Reference: the untuned chain as a MAIN chain.
            let mut reference = Core::new(48000.0, 128);
            reference.apply(
                Command::SwapChain {
                    chain: untuned_chain(name, 1),
                },
                &mut |_g| {},
            );
            let (want, _) = render_all(&mut reference, &input, 128);
            assert_eq!(mon_on, want, "{name}: monitor is not the untuned chain");
            assert_ne!(
                mon_on, main_on,
                "{name}: the monitor still hears the pitch effects"
            );
        }
    }

    /// The delay the option removes from the ears, measured with an impulse: the monitor bus
    /// answers in the same sample, the main bus one shifter grain (256 samples, 5.3 ms at
    /// 48 kHz) later per pitch insert. The meters report the same two figures.
    #[test]
    fn untuned_monitor_answers_one_grain_earlier_per_pitch_insert() {
        // Pop Polish has an autotune; Harmony Stack an autotune and a harmonizer.
        for (name, saved) in [("Pop Polish", 256), ("Harmony Stack", 512)] {
            let mut input = vec![0.0f32; 9600];
            input[1000] = 0.5;
            // Off: both buses carry the full chain, so both answer `saved` samples late.
            let (main, mon) = render_all(&mut core_with(name, false), &input, 128);
            assert_eq!(
                (onset(&main), onset(&mon)),
                (Some(1000 + saved), Some(1000 + saved)),
                "{name} off"
            );
            // On: the main bus is where it was, the monitor answers at once.
            let mut core = core_with(name, true);
            let (main, mon) = render_all(&mut core, &input, 128);
            assert_eq!(
                (onset(&main), onset(&mon)),
                (Some(1000 + saved), Some(1000)),
                "{name} on"
            );
            let m = core.meters_due().unwrap();
            assert_eq!(
                (m.chain_latency_samples, m.monitor_chain_latency_samples),
                (saved as u32, 0),
                "{name}"
            );
            let m = {
                let mut off = core_with(name, false);
                render_all(&mut off, &input, 128);
                off.meters_due().unwrap()
            };
            assert_eq!(
                (m.chain_latency_samples, m.monitor_chain_latency_samples),
                (saved as u32, saved as u32),
                "{name} off"
            );
        }
    }

    /// Turning the option on and off while singing does not click: the monitor bus crossfades
    /// between the two chains (they are 256 samples apart, so a hard switch is a jump). Twenty
    /// switches at different points of the waveform; the largest sample-to-sample step stays
    /// what it is without any switch.
    #[test]
    fn untuned_toggle_does_not_click() {
        let input = voice(3 * 48000);
        // Without a switch the monitor carries one of the two chains: the larger of their steps.
        let (main, mon) = render_all(&mut core_with("Pop Polish", true), &input, 128);
        let steady = max_step(&main[48000..]).max(max_step(&mon[48000..]));
        let mut core = core_with("Pop Polish", true);
        let mut g = |_g: Garbage| {};
        let mut mon = Vec::new();
        let mut on = true;
        for (k, blk) in input.chunks(128).enumerate() {
            // From 1 s on (the chains have settled), every 29 blocks: 3712 samples, which is
            // not a multiple of the 212-sample period, so every switch lands elsewhere in it.
            let nth = k.checked_sub(375).filter(|d| d.is_multiple_of(29));
            if nth.is_some_and(|d| d / 29 < 20) {
                on = !on;
                let chain = on.then(|| untuned_chain("Pop Polish", 1));
                core.apply(Command::SetMonitorChain { chain }, &mut g);
            }
            mon.extend(render_block(&mut core, blk).1);
            core.take_finished_tail();
        }
        assert!(mon.iter().all(|x| x.is_finite()));
        let toggled = max_step(&mon[48000..]);
        assert!(
            toggled <= steady * 1.5 + 0.002,
            "largest step with 20 switches {toggled}, without {steady}"
        );
    }

    /// A scene change with the option on: the monitor bus is held to the bound the main bus is
    /// held to in `scene_swap_is_click_free_and_rings_out` (largest sample-to-sample step below
    /// 0.25), for chains with and without pitch effects, with and without a tail, and for a
    /// scene that arrives without its monitor chain.
    #[test]
    fn untuned_scene_change_does_not_click() {
        let input: Vec<f32> = sine(220.0, 2 * 25600);
        let mut report = Vec::new();
        // (from, to, the new scene brings its monitor chain)
        for (from, to, with_monitor) in [
            ("Ballad Hall", "Speech / MC", true),
            ("Ballad Hall", "Pop Polish", true),
            ("Pop Polish", "Ballad Hall", true),
            ("Pop Polish", "Harmony Stack", true),
            ("Harmony Stack", "Natural Vocal", true),
            ("Ballad Hall", "Speech / MC", false),
            ("Pop Polish", "Hard Snap", false),
        ] {
            let mut core = core_with(from, true);
            let (mut main, mut mon) = (Vec::new(), Vec::new());
            for (k, blk) in input.chunks(128).enumerate() {
                if k == 200 {
                    let chain = preset(to).build(48000.0, 128, 100).unwrap().chain;
                    let cmd = if with_monitor {
                        let monitor = untuned_chain(to, 100);
                        Command::SwapChains { chain, monitor }
                    } else {
                        Command::SwapChain { chain }
                    };
                    core.apply(cmd, &mut |_g| {});
                }
                let (a, b) = render_block(&mut core, blk);
                main.extend(a);
                mon.extend(b);
                core.take_finished_tail();
            }
            assert!(mon.iter().all(|x| x.is_finite()));
            // 1 s in the old scene has settled; the swap is at sample 25 600.
            let (main, mon) = (max_step(&main[24000..]), max_step(&mon[24000..]));
            report.push(format!(
                "{from} -> {to} (monitor chain: {with_monitor}): monitor {mon:.4}, main {main:.4}"
            ));
            assert!(mon < 0.25, "{report:#?}");
        }
        // Shown with `-- --nocapture`: the figures quoted in the report of this change.
        println!("largest step across a scene change:\n{report:#?}");
    }

    /// A scene change that lands while the monitor crossfade is still moving, and a toggle that
    /// lands while the crossfade of a previous one is moving: neither may step the monitor bus.
    /// The case matters because `Monitor::swap` sends the old chain straight to garbage when the
    /// crossfade has not settled, so the source changes under a ramp that is not at an end.
    #[test]
    fn untuned_toggle_and_scene_change_may_overlap_without_a_click() {
        let input: Vec<f32> = sine(220.0, 2 * 25600);
        // 128-frame blocks: the crossfade is 480 samples, so gaps of 0..3 blocks overlap it.
        let mut report = Vec::new();
        for gap in [0usize, 1, 2, 3] {
            for (from, to) in [
                ("Ballad Hall", "Pop Polish"),
                ("Pop Polish", "Harmony Stack"),
            ] {
                // Option off, switched on at block 200, scene changed `gap` blocks later.
                let mut core = core_with(from, false);
                let (mut main, mut mon) = (Vec::new(), Vec::new());
                for (k, blk) in input.chunks(128).enumerate() {
                    if k == 200 {
                        let cmd = Command::SetMonitorChain {
                            chain: Some(untuned_chain(from, 100)),
                        };
                        core.apply(cmd, &mut |_g| {});
                    }
                    if k == 200 + gap {
                        let chain = preset(to).build(48000.0, 128, 100).unwrap().chain;
                        let monitor = untuned_chain(to, 100);
                        core.apply(Command::SwapChains { chain, monitor }, &mut |_g| {});
                    }
                    let (a, b) = render_block(&mut core, blk);
                    main.extend(a);
                    mon.extend(b);
                    core.take_finished_tail();
                }
                assert!(
                    mon.iter().all(|x| x.is_finite()),
                    "gap {gap}, {from} -> {to}"
                );
                // The toggle is at sample 25 600; look from 1 s before it to the end. What is
                // asserted is the MONITOR against the MAIN, not an absolute bound: while the
                // crossfade has barely started the monitor bus IS the main chain, so it inherits
                // the main bus's own step at a hard chain swap (0.2579 on Pop Polish -> Harmony
                // Stack, pre-existing and only bounded for Ballad Hall -> Speech in
                // `untuned_scene_change_does_not_click`). The point here is that the monitor's own
                // crossfade and scene swap never add a step the main bus does not already have.
                let (main, mon) = (max_step(&main[24000..]), max_step(&mon[24000..]));
                report.push(format!(
                    "toggle at 25600, {from} -> {to} {gap} block(s) later: monitor {mon:.4}, main {main:.4}"
                ));
                assert!(
                    mon <= main + 0.01,
                    "monitor stepped more than main:\n{report:#?}"
                );
                assert!(mon < 0.30, "monitor stepped:\n{report:#?}");
            }
        }
        // Shown with `-- --nocapture`.
        println!(
            "largest step when a scene change lands inside the monitor crossfade:\n{report:#?}"
        );
    }

    /// The monitor tail belongs to the monitor bus: after a scene change the ears still get the
    /// old reverb, as the audience does.
    #[test]
    fn untuned_scene_change_rings_out_the_monitor_chain() {
        let input = voice(48000);
        let mut core = core_with("Ballad Hall", true);
        let mut g = |_g: Garbage| {};
        render_all(&mut core, &input, 128);
        let chain = preset("Speech / MC")
            .build(48000.0, 128, 100)
            .unwrap()
            .chain;
        let monitor = untuned_chain("Speech / MC", 100);
        core.apply(Command::SwapChains { chain, monitor }, &mut g);
        assert!(
            core.mon.tail.chain.is_some(),
            "the old monitor chain rings out"
        );
        // Fed silence: only the tails remain on both buses, and the monitor has its own.
        let silence = vec![0.0f32; 4800];
        let (main, mon) = render_all(&mut core, &silence, 128);
        let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
        assert!(rms(&mon[2400..]) > 1e-4, "monitor tail cut: {}", rms(&mon));
        assert!(rms(&main[2400..]) > 1e-4, "main tail cut: {}", rms(&main));
    }

    /// With the option on, `render` allocates nothing: across a scene change, a toggle off and
    /// on, and the garbage hand-back.
    #[test]
    fn untuned_render_does_not_allocate() {
        let mut core = core_with("Pop Polish", true);
        let input = voice(128);
        let (mut ml, mut mr, mut ol, mut or) = (
            vec![0.0; 128],
            vec![0.0; 128],
            vec![0.0; 128],
            vec![0.0; 128],
        );
        let next = preset("Ballad Hall").build(48000.0, 128, 50).unwrap().chain;
        let next_mon = untuned_chain("Ballad Hall", 50);
        let again = untuned_chain("Ballad Hall", 50);
        let mut kept = Vec::with_capacity(16);
        assert_no_alloc::assert_no_alloc(|| {
            let mut sink = |x: Garbage| kept.push(x);
            let mut cmds = [
                Some(Command::SwapChains {
                    chain: next,
                    monitor: next_mon,
                }),
                Some(Command::SetMonitorChain { chain: None }),
                Some(Command::SetMonitorChain { chain: Some(again) }),
                Some(Command::Reset),
            ];
            for k in 0..800 {
                if k % 200 == 100 {
                    core.apply(cmds[k / 200].take().unwrap(), &mut sink);
                }
                core.render(
                    &input,
                    &input,
                    Buses {
                        main_l: &mut ml,
                        main_r: &mut mr,
                        mon_l: &mut ol,
                        mon_r: &mut or,
                    },
                );
                if let Some(t) = core.take_finished_tail() {
                    sink(Garbage::Chain(t));
                }
                let _ = core.meters_due();
            }
        });
        // The retired monitor chain and the tails cut short came back.
        assert!(kept.len() >= 3, "{} boxes back", kept.len());
    }

    /// Every box handed to the audio thread comes back: through `garbage` or
    /// `take_finished_tail`, none dropped in place, none twice.
    #[test]
    fn untuned_every_box_comes_back() {
        let mut core = Core::new(48000.0, 128);
        let input = voice(128);
        let mut ledger = Ledger::for_core(&core);
        let run = |core: &mut Core, ledger: &mut Ledger, blocks: usize| {
            for _ in 0..blocks {
                render_block(core, &input);
                ledger.collect(core);
            }
            // Checked after every step: a box lost in the middle of the sequence fails here.
            ledger.assert_balanced(core);
        };
        let ins = |id: u32, kind: FxKind| Box::new(Insert::new(id, kind, 48000.0, 128));
        let chain = preset("Pop Polish").build(48000.0, 128, 1).unwrap().chain;
        ledger.apply(&mut core, Command::SwapChain { chain });
        run(&mut core, &mut ledger, 10);
        let chain = Some(untuned_chain("Pop Polish", 1));
        ledger.apply(&mut core, Command::SetMonitorChain { chain });
        run(&mut core, &mut ledger, 30); // past the warm-up and the crossfade
        // Add a chorus (both chains), a harmonizer (main only), remove both again, remove the
        // reverb (id 7: in both chains).
        ledger.apply(
            &mut core,
            Command::AddInsertBoth {
                at: 2,
                insert: ins(40, FxKind::Chorus),
                monitor: ins(40, FxKind::Chorus),
            },
        );
        let insert = ins(41, FxKind::Harmonizer);
        ledger.apply(&mut core, Command::AddInsert { at: 3, insert });
        run(&mut core, &mut ledger, 5);
        let before = ledger.inserts_out;
        ledger.apply(&mut core, Command::RemoveInsert { insert: 40 });
        ledger.apply(&mut core, Command::RemoveInsert { insert: 41 });
        ledger.apply(&mut core, Command::RemoveInsert { insert: 7 });
        assert_eq!(
            ledger.inserts_out - before,
            2 + 1 + 2,
            "chorus x2, harmonizer, reverb x2"
        );
        run(&mut core, &mut ledger, 1);
        // A pitch effect sent as `AddInsertBoth` by mistake: its monitor copy comes straight back.
        let before = ledger.inserts_out;
        ledger.apply(
            &mut core,
            Command::AddInsertBoth {
                at: 0,
                insert: ins(42, FxKind::Autotune),
                monitor: ins(42, FxKind::Autotune),
            },
        );
        assert_eq!(ledger.inserts_out - before, 1);
        assert!(
            core.monitor_chain()
                .unwrap()
                .inserts
                .iter()
                .all(|i| i.id != 42)
        );
        run(&mut core, &mut ledger, 1);
        // Scene change with tails on both buses, then another before they finished.
        for first_id in [100, 200] {
            let chain = preset("Ballad Hall")
                .build(48000.0, 128, first_id)
                .unwrap()
                .chain;
            let monitor = untuned_chain("Ballad Hall", first_id);
            ledger.apply(&mut core, Command::SwapChains { chain, monitor });
            assert!(core.tail.chain.is_some() && core.mon.tail.chain.is_some());
            run(&mut core, &mut ledger, 20);
        }
        // A full chain: the insert that does not fit comes back, on both chains.
        let room = MAX_INSERTS - core.chain.inserts.len();
        for k in 0..room as u32 + 2 {
            ledger.apply(
                &mut core,
                Command::AddInsertBoth {
                    at: 1,
                    insert: ins(500 + k, FxKind::Gate),
                    monitor: ins(500 + k, FxKind::Gate),
                },
            );
        }
        assert_eq!(core.chain.inserts.len(), MAX_INSERTS);
        run(&mut core, &mut ledger, 1);
        // Option off, then a plain swap, then on again, then off; reset in between.
        ledger.apply(&mut core, Command::SetMonitorChain { chain: None });
        run(&mut core, &mut ledger, 2);
        let chain = preset("Speech / MC")
            .build(48000.0, 128, 300)
            .unwrap()
            .chain;
        ledger.apply(&mut core, Command::SwapChain { chain });
        run(&mut core, &mut ledger, 2);
        let chain = Some(untuned_chain("Speech / MC", 300));
        ledger.apply(&mut core, Command::SetMonitorChain { chain });
        // Off and on again within the 10 ms fade (the chain is replaced mid-fade).
        ledger.apply(&mut core, Command::SetMonitorChain { chain: None });
        let chain = Some(untuned_chain("Speech / MC", 300));
        ledger.apply(&mut core, Command::SetMonitorChain { chain });
        run(&mut core, &mut ledger, 1);
        // On while it is already on and heard (a host that sends it twice): the new chain waits
        // until the old one has faded out.
        run(&mut core, &mut ledger, 30);
        let chain = Some(untuned_chain("Speech / MC", 300));
        ledger.apply(&mut core, Command::SetMonitorChain { chain });
        assert!(core.mon.next.is_some(), "the new chain waits its turn");
        run(&mut core, &mut ledger, 1);
        run(&mut core, &mut ledger, 4);
        assert!(core.mon.next.is_none() && core.mon.chain.is_some());
        // ... and again, replaced while it waits.
        run(&mut core, &mut ledger, 30);
        for _ in 0..2 {
            let chain = Some(untuned_chain("Speech / MC", 300));
            ledger.apply(&mut core, Command::SetMonitorChain { chain });
        }
        run(&mut core, &mut ledger, 1);
        // A plain swap while the option is on, with a tail on the monitor bus.
        let chain = preset("Ballad Hall")
            .build(48000.0, 128, 400)
            .unwrap()
            .chain;
        let monitor = untuned_chain("Ballad Hall", 400);
        ledger.apply(&mut core, Command::SwapChains { chain, monitor });
        let chain = preset("Speech / MC")
            .build(48000.0, 128, 600)
            .unwrap()
            .chain;
        ledger.apply(&mut core, Command::SwapChain { chain });
        run(&mut core, &mut ledger, 3);
        ledger.apply(&mut core, Command::Reset);
        ledger.apply(&mut core, Command::SetMonitorChain { chain: None });
        // Everything rings out (6 s cap) and the retired monitor chain is collected.
        run(&mut core, &mut ledger, 6 * 48000 / 128 + 10);
        // What is still alive: the main chain only.
        assert!(core.mon.chain.is_none() && core.mon.next.is_none());
        assert!(core.mon.tail.chain.is_none());
        assert!(core.tail.chain.is_none());
        assert_eq!(ledger.chains_in, ledger.chains_out + 1);
    }

    /// Positions are translated to the monitor chain's order: `at` / `to` count the pitch
    /// inserts, the monitor chain does not have them.
    #[test]
    fn untuned_positions_skip_the_pitch_inserts() {
        // Harmony Stack: eq 1, compressor 2, autotune 3, harmonizer 4, reverb 5, limiter 6.
        let mut core = core_with("Harmony Stack", true);
        let ids = |c: &Chain| c.inserts.iter().map(|i| i.id).collect::<Vec<_>>();
        let mut g = |_g: Garbage| {};
        assert_eq!(ids(core.monitor_chain().unwrap()), [1, 2, 5, 6]);
        let ins = |id: u32| Box::new(Insert::new(id, FxKind::Chorus, 48000.0, 128));
        // (position in the main chain, expected main order, expected monitor order)
        let mut add = |core: &mut Core, id: u32, at: usize| {
            core.apply(
                Command::AddInsertBoth {
                    at,
                    insert: ins(id),
                    monitor: ins(id),
                },
                &mut g,
            );
            (ids(core.chain()), ids(core.monitor_chain().unwrap()))
        };
        // Right before the autotune, between the two pitch inserts, right after them, at the
        // end and past the end.
        assert_eq!(
            add(&mut core, 10, 2),
            (vec![1, 2, 10, 3, 4, 5, 6], vec![1, 2, 10, 5, 6])
        );
        assert_eq!(
            add(&mut core, 11, 4),
            (vec![1, 2, 10, 3, 11, 4, 5, 6], vec![1, 2, 10, 11, 5, 6])
        );
        assert_eq!(
            add(&mut core, 12, 6),
            (
                vec![1, 2, 10, 3, 11, 4, 12, 5, 6],
                vec![1, 2, 10, 11, 12, 5, 6]
            )
        );
        assert_eq!(add(&mut core, 13, 99).1, [1, 2, 10, 11, 12, 5, 6, 13]);
        assert_eq!(add(&mut core, 14, 0).1, [14, 1, 2, 10, 11, 12, 5, 6, 13]);
        // main: 14 1 2 10 3 11 4 12 5 6 13
        let mv = |core: &mut Core, insert: u32, to: usize| {
            core.apply(Command::MoveInsert { insert, to }, &mut |_g| {});
            (ids(core.chain()), ids(core.monitor_chain().unwrap()))
        };
        // The reverb (5) across both pitch inserts to the front of the autotune.
        assert_eq!(
            mv(&mut core, 5, 4),
            (
                vec![14, 1, 2, 10, 5, 3, 11, 4, 12, 6, 13],
                vec![14, 1, 2, 10, 5, 11, 12, 6, 13]
            )
        );
        // The eq (1) to between the pitch inserts, then to the very end.
        assert_eq!(
            mv(&mut core, 1, 5),
            (
                vec![14, 2, 10, 5, 3, 1, 11, 4, 12, 6, 13],
                vec![14, 2, 10, 5, 1, 11, 12, 6, 13]
            )
        );
        assert_eq!(mv(&mut core, 1, 99).1, [14, 2, 10, 5, 11, 12, 6, 13, 1]);
        // Moving a pitch insert changes the main chain only.
        assert_eq!(
            mv(&mut core, 3, 0),
            (
                vec![3, 14, 2, 10, 5, 11, 4, 12, 6, 13, 1],
                vec![14, 2, 10, 5, 11, 12, 6, 13, 1]
            )
        );
        // An id nobody has changes nothing.
        assert_eq!(mv(&mut core, 77, 0).1, [14, 2, 10, 5, 11, 12, 6, 13, 1]);
    }

    /// A `SwapChain` from a host that knows nothing about the monitor chain turns the option
    /// off cleanly: the monitor fades back to the main chain and the old monitor chain is
    /// collected.
    #[test]
    fn untuned_plain_swap_falls_back_to_the_main_chain() {
        let mut core = core_with("Pop Polish", true);
        let input = voice(128);
        assert!(core.monitor_chain().is_some());
        let chain = preset("Hard Snap").build(48000.0, 128, 100).unwrap().chain;
        core.apply(Command::SwapChain { chain }, &mut |_g| {});
        assert!(core.monitor_chain().is_none());
        let mut back = 0;
        for _ in 0..10 {
            render_block(&mut core, &input);
            if core.take_finished_tail().is_some() {
                back += 1;
            }
        }
        assert_eq!(
            back, 1,
            "the monitor chain comes back once the fade is over"
        );
        let m = {
            render_all(&mut core, &voice(4800), 128);
            core.meters_due().unwrap()
        };
        // The ears are back on the main chain: whatever the pitch effect costs right now, the
        // monitor reports the same figure. With `fast = auto` that is not a fixed 256 any more -
        // the fast shifter is 1 sample and `auto` takes it for notes at or above 187.5 Hz, so the
        // assertion is equality plus "it is the pitch effect's figure", not one specific number.
        assert_eq!(
            m.chain_latency_samples, m.monitor_chain_latency_samples,
            "the ears must hear the main chain again"
        );
        assert!(
            matches!(m.chain_latency_samples, 1 | 256),
            "the main chain still carries the pitch effect's latency, got {}",
            m.chain_latency_samples
        );
    }

    /// With the option on the monitor bus keeps everything it had: bypass, the dry blend, its
    /// gain, mute, the latency-probe click and the safety stage.
    #[test]
    fn untuned_monitor_keeps_bypass_dry_gain_mute_probe_and_safety() {
        let input = voice(48000);
        let settled = 24000..48000;
        let run = |cmds: Vec<Command>| {
            let mut core = core_with("Pop Polish", true);
            for c in cmds {
                core.apply(c, &mut |_g| {});
            }
            render_all(&mut core, &input, 128).1
        };
        let worst = |a: &[f32], b: &[f32]| {
            a.iter()
                .zip(b)
                .map(|(x, y)| (x - y).abs())
                .fold(0.0, f32::max)
        };
        let plain = run(vec![]);
        let dry = &input[settled.clone()];
        assert!(
            worst(&plain[settled.clone()], dry) > 0.01,
            "chain did nothing"
        );
        // Bypass and the dry blend at 1: the input itself.
        let bypassed = run(vec![Command::Bypass(true)]);
        assert!(worst(&bypassed[settled.clone()], dry) < 1e-6, "bypass");
        let all_dry = run(vec![Command::MonitorDry(1.0)]);
        assert!(worst(&all_dry[settled.clone()], dry) < 1e-6, "monitor dry");
        // Dry blend at 0.5: half way between the input and the untuned chain.
        let half = run(vec![Command::MonitorDry(0.5)]);
        let want: Vec<f32> = plain[settled.clone()]
            .iter()
            .zip(dry)
            .map(|(p, d)| 0.5 * (p + d))
            .collect();
        assert!(
            worst(&half[settled.clone()], &want) < 1e-6,
            "monitor dry 0.5"
        );
        // Monitor gain −6.02 dB: half the level.
        let quiet = run(vec![Command::MonitorGain(-6.0206)]);
        let want: Vec<f32> = plain[settled.clone()].iter().map(|p| 0.5 * p).collect();
        assert!(worst(&quiet[settled.clone()], &want) < 1e-5, "monitor gain");
        // Mute: silence; the probe click still goes out (it is how latency is measured).
        let muted = run(vec![Command::Mute(true)]);
        assert!(muted[settled.clone()].iter().all(|v| *v == 0.0), "mute");
        let probing = run(vec![Command::Mute(true), Command::StartLatencyProbe]);
        let click = probing.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(click > 0.8, "probe click on the monitor bus: {click}");
        // Every fader up on a full-scale input: the safety stage holds the ceiling.
        let hot: Vec<f32> = (0..48000)
            .map(|i| (core::f32::consts::TAU * 220.0 * i as f32 / 48000.0).sin())
            .collect();
        let mut core = core_with("Pop Polish", true);
        for c in [
            Command::InputGain(12.0),
            Command::MonitorGain(12.0),
            Command::MainGain(12.0),
        ] {
            core.apply(c, &mut |_g| {});
        }
        let (main, mon) = render_all(&mut core, &hot, 128);
        let peak = |x: &[f32]| x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak(&mon) <= SAFETY_CEILING && peak(&main) <= SAFETY_CEILING);
        assert!(
            peak(&mon) > 0.5,
            "the monitor bus went quiet: {}",
            peak(&mon)
        );
    }

    /// A measurement, not a check: the time `render` takes for 10 s of audio with the option
    /// off and on. Run it optimised:
    /// `cargo test --release -p live-engine --lib untuned_cpu_cost -- --ignored --nocapture`.
    #[test]
    #[ignore = "measurement: prints render times with the monitor option off and on"]
    fn untuned_cpu_cost() {
        let input = voice(10 * 48000);
        let (mut ml, mut mr, mut ol, mut or) = (
            vec![0.0; 128],
            vec![0.0; 128],
            vec![0.0; 128],
            vec![0.0; 128],
        );
        for name in ["Pop Polish", "Harmony Stack", "Natural Vocal"] {
            let mut time = |untuned: bool| {
                let mut core = core_with(name, untuned);
                let t0 = std::time::Instant::now();
                for blk in input.chunks(128) {
                    core.render(
                        blk,
                        blk,
                        Buses {
                            main_l: &mut ml,
                            main_r: &mut mr,
                            mon_l: &mut ol,
                            mon_r: &mut or,
                        },
                    );
                }
                t0.elapsed().as_secs_f64() * 1000.0
            };
            // Best of five, alternating, so a busy machine skews both the same way.
            let (mut off, mut on) = (f64::INFINITY, f64::INFINITY);
            for _ in 0..5 {
                off = off.min(time(false));
                on = on.min(time(true));
            }
            println!(
                "{name}: render of 10 s of audio in 128-frame blocks: option off {off:.1} ms, \
                 on {on:.1} ms ({:+.0} %); share of real time {:.2} % -> {:.2} %",
                (on / off - 1.0) * 100.0,
                off / 100.0,
                on / 100.0
            );
        }
    }
}
