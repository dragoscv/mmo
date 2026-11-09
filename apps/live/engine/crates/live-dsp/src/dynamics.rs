//! Gate/expander, compressor, limiter and split-band de-esser. Stereo-linked detection.

use crate::biquad::{Biquad, Coefs};
use crate::param::{ParamSpec, Smoothed, Unit, db_to_lin, lin_to_db, one_pole_coef};
use crate::processor::{Processor, defaults, store};

// ─── Gate / expander ────────────────────────────────────────────────────────

const GATE_SPECS: &[ParamSpec] = &[
    ParamSpec::new("threshold", -90.0, 0.0, -50.0, Unit::Db),
    ParamSpec::new("range", -90.0, 0.0, -40.0, Unit::Db),
    ParamSpec::new("ratio", 1.0, 20.0, 4.0, Unit::Ratio),
    ParamSpec::log("attack", 0.05, 50.0, 0.5, Unit::Ms),
    ParamSpec::log("hold", 1.0, 500.0, 40.0, Unit::Ms),
    ParamSpec::log("release", 5.0, 2000.0, 120.0, Unit::Ms),
    ParamSpec::new("hysteresis", 0.0, 12.0, 4.0, Unit::Db),
];

/// Downward expander with hold and hysteresis; `ratio = 20` behaves as a hard gate.
pub struct Gate {
    sr: f32,
    v: [f32; 7],
    env: f32,
    gain_db: f32,
    open: bool,
    hold_left: u32,
    det_att: f32,
    det_rel: f32,
    att: f32,
    rel: f32,
    hold: u32,
}

impl Gate {
    pub fn new(sample_rate: f32) -> Self {
        let mut g = Self {
            sr: sample_rate,
            v: defaults(GATE_SPECS),
            env: 0.0,
            gain_db: 0.0,
            open: false,
            hold_left: 0,
            det_att: one_pole_coef(0.2, sample_rate),
            det_rel: one_pole_coef(15.0, sample_rate),
            att: 0.0,
            rel: 0.0,
            hold: 0,
        };
        g.update();
        g
    }

    fn update(&mut self) {
        self.att = one_pole_coef(self.v[3], self.sr);
        self.hold = (self.v[4] * 0.001 * self.sr) as u32;
        self.rel = one_pole_coef(self.v[5], self.sr);
    }
}

impl Processor for Gate {
    fn specs(&self) -> &'static [ParamSpec] {
        GATE_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if store(&mut self.v, GATE_SPECS, i, v).is_some() {
            self.update();
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let thr = self.v[0];
        let range = self.v[1];
        let ratio = self.v[2];
        let hyst = self.v[6];
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let x = a.abs().max(b.abs());
            let c = if x > self.env {
                self.det_att
            } else {
                self.det_rel
            };
            self.env += c * (x - self.env);
            let lvl = lin_to_db(self.env);
            if lvl > thr {
                self.open = true;
                self.hold_left = self.hold;
            } else if lvl < thr - hyst {
                if self.hold_left > 0 {
                    self.hold_left -= 1;
                } else {
                    self.open = false;
                }
            }
            let target = if self.open {
                0.0
            } else {
                ((lvl - thr) * (ratio - 1.0)).clamp(range, 0.0)
            };
            let coef = if target > self.gain_db {
                self.att
            } else {
                self.rel
            };
            self.gain_db += coef * (target - self.gain_db);
            let g = db_to_lin(self.gain_db);
            *a *= g;
            *b *= g;
        }
    }
    fn reset(&mut self) {
        self.env = 0.0;
        self.gain_db = 0.0;
        self.open = false;
        self.hold_left = 0;
    }
    fn gain_reduction_db(&self) -> f32 {
        -self.gain_db
    }
}

// ─── Compressor ─────────────────────────────────────────────────────────────

const COMP_SPECS: &[ParamSpec] = &[
    ParamSpec::new("threshold", -60.0, 0.0, -18.0, Unit::Db),
    ParamSpec::new("ratio", 1.0, 20.0, 3.0, Unit::Ratio),
    ParamSpec::new("knee", 0.0, 24.0, 6.0, Unit::Db),
    ParamSpec::log("attack", 0.05, 200.0, 5.0, Unit::Ms),
    ParamSpec::log("release", 5.0, 3000.0, 120.0, Unit::Ms),
    ParamSpec::new("makeup", -12.0, 24.0, 0.0, Unit::Db),
    ParamSpec::toggle("auto_makeup", false),
    ParamSpec::new("mix", 0.0, 1.0, 1.0, Unit::Percent),
    ParamSpec::log("sidechain_hpf", 20.0, 500.0, 80.0, Unit::Hz),
];

/// Feed-forward log-domain compressor with soft knee, program-independent release,
/// sidechain high-pass (no pumping on plosives) and parallel mix.
pub struct Compressor {
    sr: f32,
    v: [f32; 9],
    gr_db: f32,
    att: f32,
    rel: f32,
    hpf: [Biquad; 2],
    makeup: Smoothed,
    mix: Smoothed,
    limiter: bool,
    last_gr: f32,
}

impl Compressor {
    pub fn new(sample_rate: f32) -> Self {
        Self::build(sample_rate, false)
    }

    fn build(sample_rate: f32, limiter: bool) -> Self {
        let specs = if limiter { LIM_SPECS } else { COMP_SPECS };
        let mut v = [0.0f32; 9];
        for (o, s) in v.iter_mut().zip(specs) {
            *o = s.default;
        }
        let mut c = Self {
            sr: sample_rate,
            v,
            gr_db: 0.0,
            att: 0.0,
            rel: 0.0,
            hpf: [Biquad::default(); 2],
            makeup: Smoothed::with_ms(1.0, 20.0, sample_rate),
            mix: Smoothed::with_ms(1.0, 20.0, sample_rate),
            limiter,
            last_gr: 0.0,
        };
        c.update();
        c.makeup.reset(c.makeup.target());
        c.mix.reset(c.mix.target());
        c
    }

    fn update(&mut self) {
        if self.limiter {
            self.att = one_pole_coef(self.v[1], self.sr);
            self.rel = one_pole_coef(self.v[2], self.sr);
            self.makeup.set(1.0);
            self.mix.set(1.0);
        } else {
            self.att = one_pole_coef(self.v[3], self.sr);
            self.rel = one_pole_coef(self.v[4], self.sr);
            let auto = if self.v[6] > 0.5 {
                -self.v[0] * (1.0 - 1.0 / self.v[1]) * 0.5
            } else {
                0.0
            };
            self.makeup.set(db_to_lin(self.v[5] + auto));
            self.mix.set(self.v[7]);
            let c = Coefs::high_pass(self.v[8], 0.707, self.sr);
            for f in &mut self.hpf {
                f.set(c);
            }
        }
    }

    #[inline]
    fn curve(over: f32, ratio: f32, knee: f32) -> f32 {
        let slope = 1.0 - 1.0 / ratio;
        if knee <= 0.0 {
            return if over > 0.0 { over * slope } else { 0.0 };
        }
        let h = knee * 0.5;
        if over >= h {
            over * slope
        } else if over > -h {
            let k = over + h;
            k * k / (2.0 * knee) * slope
        } else {
            0.0
        }
    }
}

impl Processor for Compressor {
    fn specs(&self) -> &'static [ParamSpec] {
        if self.limiter { LIM_SPECS } else { COMP_SPECS }
    }
    fn set_param(&mut self, i: usize, v: f32) {
        let specs = self.specs();
        if store(&mut self.v, specs, i, v).is_some() {
            self.update();
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let (thr, ratio, knee) = if self.limiter {
            (self.v[0], 1000.0, 0.5)
        } else {
            (self.v[0], self.v[1], self.v[2])
        };
        let mut peak_gr = 0.0f32;
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let (da, db) = if self.limiter {
                (*a, *b)
            } else {
                (self.hpf[0].tick(*a), self.hpf[1].tick(*b))
            };
            let det = da.abs().max(db.abs());
            let target = Self::curve(lin_to_db(det) - thr, ratio, knee);
            let coef = if target > self.gr_db {
                self.att
            } else {
                self.rel
            };
            self.gr_db += coef * (target - self.gr_db);
            peak_gr = peak_gr.max(self.gr_db);
            let g = db_to_lin(-self.gr_db) * self.makeup.next();
            let m = self.mix.next();
            let ya = *a * g;
            let yb = *b * g;
            *a = *a + m * (ya - *a);
            *b = *b + m * (yb - *b);
            if self.limiter {
                // Safety clip after the smoothed limiter for intersample overs.
                let ceil = db_to_lin(self.v[0]);
                *a = a.clamp(-ceil, ceil);
                *b = b.clamp(-ceil, ceil);
            }
        }
        self.last_gr = peak_gr;
    }
    fn reset(&mut self) {
        self.gr_db = 0.0;
        self.last_gr = 0.0;
        for f in &mut self.hpf {
            f.reset();
        }
    }
    fn gain_reduction_db(&self) -> f32 {
        self.last_gr
    }
}

// ─── Limiter ────────────────────────────────────────────────────────────────

const LIM_SPECS: &[ParamSpec] = &[
    ParamSpec::new("ceiling", -24.0, 0.0, -1.0, Unit::Db),
    ParamSpec::log("attack", 0.01, 10.0, 0.1, Unit::Ms),
    ParamSpec::log("release", 5.0, 1000.0, 60.0, Unit::Ms),
    ParamSpec::new("input", -12.0, 24.0, 0.0, Unit::Db),
];

/// Brick-wall safety limiter (no lookahead: zero latency for in-ear use) with a final clamp.
pub struct Limiter(Compressor);

impl Limiter {
    pub fn new(sample_rate: f32) -> Self {
        Self(Compressor::build(sample_rate, true))
    }
}

impl Processor for Limiter {
    fn specs(&self) -> &'static [ParamSpec] {
        LIM_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        self.0.set_param(i, v);
    }
    fn param(&self, i: usize) -> f32 {
        self.0.param(i)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        // Input drive is applied before detection; the ceiling clamp follows in the core.
        let drive = db_to_lin(self.0.v[3]);
        if drive != 1.0 {
            for (a, b) in l.iter_mut().zip(r.iter_mut()) {
                *a *= drive;
                *b *= drive;
            }
        }
        self.0.process(l, r);
    }
    fn reset(&mut self) {
        self.0.reset();
    }
    fn gain_reduction_db(&self) -> f32 {
        self.0.gain_reduction_db()
    }
}

// ─── De-esser ───────────────────────────────────────────────────────────────

const DEESS_SPECS: &[ParamSpec] = &[
    ParamSpec::log("frequency", 2000.0, 12000.0, 6500.0, Unit::Hz),
    ParamSpec::new("threshold", -60.0, 0.0, -30.0, Unit::Db),
    ParamSpec::new("range", 0.0, 24.0, 10.0, Unit::Db),
    ParamSpec::choice("mode", &["split", "wide"], 0),
    ParamSpec::toggle("listen", false),
];

/// Split-band de-esser: only the sibilant band above `frequency` is attenuated in `split`
/// mode (the dry low band is always kept — this is the bug the browser version had).
pub struct DeEsser {
    sr: f32,
    v: [f32; 5],
    det: [Biquad; 2],
    split_hp: [Biquad; 2],
    split_lp: [Biquad; 2],
    env: f32,
    gr_db: f32,
    att: f32,
    rel: f32,
}

impl DeEsser {
    pub fn new(sample_rate: f32) -> Self {
        let mut d = Self {
            sr: sample_rate,
            v: defaults(DEESS_SPECS),
            det: [Biquad::default(); 2],
            split_hp: [Biquad::default(); 2],
            split_lp: [Biquad::default(); 2],
            env: 0.0,
            gr_db: 0.0,
            att: one_pole_coef(0.3, sample_rate),
            rel: one_pole_coef(60.0, sample_rate),
        };
        d.update();
        d
    }

    fn update(&mut self) {
        let f = self.v[0];
        let bp = Coefs::band_pass(f, 1.4, self.sr);
        for b in &mut self.det {
            b.set(bp);
        }
        // Linkwitz-Riley-ish complementary split (2nd order HP/LP at Q 0.5 sum flat in magnitude).
        let hp = Coefs::high_pass(f * 0.8, 0.5, self.sr);
        let lp = Coefs::low_pass(f * 0.8, 0.5, self.sr);
        for b in &mut self.split_hp {
            b.set(hp);
        }
        for b in &mut self.split_lp {
            b.set(lp);
        }
    }
}

impl Processor for DeEsser {
    fn specs(&self) -> &'static [ParamSpec] {
        DEESS_SPECS
    }
    fn set_param(&mut self, i: usize, v: f32) {
        if store(&mut self.v, DEESS_SPECS, i, v).is_some() {
            self.update();
        }
    }
    fn param(&self, i: usize) -> f32 {
        self.v.get(i).copied().unwrap_or(0.0)
    }
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let thr = self.v[1];
        let range = self.v[2];
        let split = self.v[3] < 0.5;
        let listen = self.v[4] > 0.5;
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let sa = self.det[0].tick(*a);
            let sb = self.det[1].tick(*b);
            let x = sa.abs().max(sb.abs());
            let c = if x > self.env { self.att } else { self.rel };
            self.env += c * (x - self.env);
            let over = lin_to_db(self.env) - thr;
            let target = (over * 0.75).clamp(0.0, range);
            let k = if target > self.gr_db {
                self.att
            } else {
                self.rel
            };
            self.gr_db += k * (target - self.gr_db);
            let g = db_to_lin(-self.gr_db);
            if listen {
                *a = sa;
                *b = sb;
            } else if split {
                let ha = self.split_hp[0].tick(*a);
                let hb = self.split_hp[1].tick(*b);
                let la = self.split_lp[0].tick(*a);
                let lb = self.split_lp[1].tick(*b);
                // HP + LP at Q 0.5 is in phase-quadrature-free sum; recombine low band dry.
                *a = la + ha * g;
                *b = lb + hb * g;
            } else {
                *a *= g;
                *b *= g;
            }
        }
    }
    fn reset(&mut self) {
        self.env = 0.0;
        self.gr_db = 0.0;
        for f in self
            .det
            .iter_mut()
            .chain(&mut self.split_hp)
            .chain(&mut self.split_lp)
        {
            f.reset();
        }
    }
    fn gain_reduction_db(&self) -> f32 {
        self.gr_db
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::{rms, sine};

    #[test]
    fn compressor_reduces_loud_signal() {
        let mut c = Compressor::new(48000.0);
        c.set_param(0, -30.0);
        c.set_param(1, 4.0);
        c.set_param(2, 0.0);
        let mut l = sine(440.0, 48000.0, 48000, 0.9);
        let mut r = l.clone();
        let before = rms(&l[24000..]);
        c.process(&mut l, &mut r);
        let after = rms(&l[24000..]);
        let gr = 20.0 * (before / after).log10();
        // input ~ -4 dBFS rms vs -30 threshold at 4:1 => ~19 dB reduction.
        assert!(gr > 14.0 && gr < 24.0, "gr {gr}");
    }

    #[test]
    fn gate_closes_on_quiet_input() {
        let mut g = Gate::new(48000.0);
        g.set_param(0, -40.0);
        g.set_param(2, 20.0);
        let mut l = sine(200.0, 48000.0, 24000, 0.001);
        let mut r = l.clone();
        g.process(&mut l, &mut r);
        assert!(rms(&l[12000..]) < 0.0001);
    }

    #[test]
    fn limiter_respects_ceiling() {
        let mut lim = Limiter::new(48000.0);
        lim.set_param(0, -6.0);
        let mut l = sine(100.0, 48000.0, 9600, 1.0);
        let mut r = l.clone();
        lim.process(&mut l, &mut r);
        let ceil = db_to_lin(-6.0) + 1e-6;
        assert!(l.iter().all(|x| x.abs() <= ceil));
    }

    #[test]
    fn deesser_keeps_low_band() {
        let mut d = DeEsser::new(48000.0);
        d.set_param(1, -60.0); // always compress the sibilant band
        let mut l = sine(300.0, 48000.0, 24000, 0.5);
        let mut r = l.clone();
        let before = rms(&l[12000..]);
        d.process(&mut l, &mut r);
        let after = rms(&l[12000..]);
        assert!((after / before) > 0.85, "low band lost: {}", after / before);
    }

    #[test]
    fn deesser_cuts_sibilance() {
        let mut d = DeEsser::new(48000.0);
        d.set_param(1, -40.0);
        let mut l = sine(7000.0, 48000.0, 24000, 0.5);
        let mut r = l.clone();
        let before = rms(&l[12000..]);
        d.process(&mut l, &mut r);
        assert!(rms(&l[12000..]) < before * 0.5);
    }
}
