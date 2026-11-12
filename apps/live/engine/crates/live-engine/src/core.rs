//! The audio-thread side: chain + scene spill-over + buses + meters + latency probe.
//! Device-independent so it is unit-tested and used for offline rendering.

use crate::latency::{LatencyProbe, Phase};
use live_dsp::chain::MAX_INSERTS;
use live_dsp::{Chain, Insert, Smoothed, TuneStatus, db_to_lin};

/// Messages from the control thread. Boxes are allocated on the control thread; the audio
/// thread only moves pointers and sends the old ones back through [`Garbage`].
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
    RemoveInsert {
        insert: u32,
    },
    MoveInsert {
        insert: u32,
        to: usize,
    },
    /// Scene / preset change: the old chain keeps ringing out (fed silence) for its tail.
    SwapChain {
        chain: Box<Chain>,
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
    pub chain_latency_samples: u32,
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

pub struct Core {
    sr: f32,
    max_block: usize,
    chain: Box<Chain>,
    tail: Option<Box<Chain>>,
    tail_gain: Smoothed,
    tail_left: usize,
    scratch: [Vec<f32>; 4],
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
            tail: None,
            tail_gain: Smoothed::with_ms(0.0, 0.0, sample_rate),
            tail_left: 0,
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
            }
            Command::SetEnabled { insert, on } => {
                if let Some(i) = self.chain.find_mut(insert) {
                    i.set_enabled(on);
                }
            }
            Command::AddInsert { at, insert } => {
                if let Err(back) = self.chain.try_insert(at, insert) {
                    garbage(Garbage::Insert(back));
                }
            }
            Command::RemoveInsert { insert } => {
                if let Some(b) = self.chain.remove(insert) {
                    garbage(Garbage::Insert(b));
                }
            }
            Command::MoveInsert { insert, to } => {
                self.chain.move_to(insert, to);
            }
            Command::SwapChain { chain } => {
                let old = core::mem::replace(&mut self.chain, chain);
                let tail_s = old.tail_seconds().min(6.0);
                if let Some(prev) = self.tail.take() {
                    garbage(Garbage::Chain(prev));
                }
                if tail_s > 0.0 {
                    self.tail_left = (tail_s * self.sr) as usize;
                    self.tail_gain.set_ramp(self.tail_left as u32);
                    self.tail_gain.reset(1.0);
                    self.tail_gain.set(0.0);
                    self.tail = Some(old);
                } else {
                    garbage(Garbage::Chain(old));
                }
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
                if let Some(t) = self.tail.take() {
                    garbage(Garbage::Chain(t));
                }
            }
        }
    }

    /// Process one block. `input_l/r` hold the input (mono sources pass the same slice twice
    /// via copy before calling). Every slice has the same length `<= max_block`.
    pub fn render(&mut self, input_l: &[f32], input_r: &[f32], out: Buses<'_>) {
        let n = input_l.len().min(self.max_block);
        let [wl, wr, dl, dr] = &mut self.scratch;
        let (wl, wr, dl, dr) = (&mut wl[..n], &mut wr[..n], &mut dl[..n], &mut dr[..n]);
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
        self.chain.process(wl, wr);
        if let Some(t) = self.tail.as_mut() {
            // Ring out the previous scene's tails, fed silence, fading over the tail length.
            let mut tl = [0.0f32; 256];
            let mut tr = [0.0f32; 256];
            let mut off = 0;
            while off < n {
                let m = (n - off).min(256);
                tl[..m].fill(0.0);
                tr[..m].fill(0.0);
                t.process(&mut tl[..m], &mut tr[..m]);
                for k in 0..m {
                    let g = self.tail_gain.next();
                    wl[off + k] += tl[k] * g;
                    wr[off + k] += tr[k] * g;
                }
                off += m;
            }
            self.tail_left = self.tail_left.saturating_sub(n);
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
            let (ol, or) = self.safety[1].tick(
                (pl + md * (dl[i] - pl)) * mo + probe,
                (pr + md * (dr[i] - pr)) * mo + probe,
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
        if self.tail.is_some() && self.tail_left == 0 {
            // Finished ringing out; the box is freed when the next garbage pass runs.
            self.tail_gain.reset(0.0);
        }
    }

    /// Hand back a finished tail chain (call after `render`, outside the hot loop).
    pub fn take_finished_tail(&mut self) -> Option<Box<Chain>> {
        if self.tail.is_some() && self.tail_left == 0 {
            self.tail.take()
        } else {
            None
        }
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
            core.tail.is_some(),
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
}
