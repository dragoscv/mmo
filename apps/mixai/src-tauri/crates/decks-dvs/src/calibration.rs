//! Signal-quality measurement for the calibration / scope view.

/// Signal quality report for the UI (calibration panel).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SignalReport {
    /// Carrier currently detected.
    pub present: bool,
    /// Left channel RMS level, dBFS (after DC removal).
    pub level_left_dbfs: f32,
    /// Right channel RMS level, dBFS.
    pub level_right_dbfs: f32,
    /// Left minus right level, dB (0 = balanced).
    pub balance_db: f32,
    /// Deviation of the L/R phase difference from the ideal 90°, degrees (signed).
    pub phase_error_deg: f32,
    /// Noise floor, dBFS (per channel).
    pub noise_floor_dbfs: f32,
    /// Estimated signal-to-noise ratio, dB.
    pub snr_db: f32,
    /// Share of decoded bits matching the position code while locked (absolute mode only).
    pub valid_bits_pct: Option<f32>,
    /// Current automatic presence threshold (linear envelope).
    pub threshold: f32,
    /// Last reported speed.
    pub speed: f32,
}

/// Running (EMA) accumulators; updated per sample/cycle from the decoder, never allocates.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Calibration {
    coef: f32,
    l2: f32,
    r2: f32,
    lr: f32,
    noise_var: f32,
    noise_seen: bool,
    absent_env: f32,
}

fn db_power(p: f32) -> f32 {
    10.0 * p.max(1e-12).log10()
}

impl Calibration {
    pub(crate) fn new(sample_rate: f32) -> Self {
        // ~200 ms time constant.
        let coef = 1.0 - (-1.0 / (0.2 * sample_rate)).exp();
        Self {
            coef,
            l2: 0.0,
            r2: 0.0,
            lr: 0.0,
            noise_var: 0.0,
            noise_seen: false,
            absent_env: 0.0,
        }
    }

    pub(crate) fn reset(&mut self) {
        *self = Self {
            coef: self.coef,
            ..Self::new(1.0)
        };
    }

    #[inline]
    pub(crate) fn observe_present(&mut self, l: f32, r: f32) {
        self.l2 += self.coef * (l * l - self.l2);
        self.r2 += self.coef * (r * r - self.r2);
        self.lr += self.coef * (l * r - self.lr);
    }

    #[inline]
    pub(crate) fn observe_absent(&mut self, env: f32) {
        self.absent_env += self.coef * (env - self.absent_env);
    }

    /// `var`: variance of the envelope inside one cycle's flat (mid) part = radial noise power.
    #[inline]
    pub(crate) fn observe_cycle(&mut self, var: f32) {
        if self.noise_seen {
            self.noise_var += 0.02 * (var - self.noise_var);
        } else {
            self.noise_var = var;
            self.noise_seen = true;
        }
    }

    pub(crate) fn absent_env(&self) -> f32 {
        self.absent_env
    }

    pub(crate) fn noise_power(&self) -> f32 {
        if self.noise_seen {
            self.noise_var
        } else {
            // Rayleigh envelope mean = σ·√(π/2) → σ² ≈ 2·mean²/π.
            2.0 * self.absent_env * self.absent_env / std::f32::consts::PI
        }
    }

    pub(crate) fn snr_db(&self) -> f32 {
        db_power(0.5 * (self.l2 + self.r2)) - db_power(self.noise_power())
    }

    pub(crate) fn phase_error_deg(&self) -> f32 {
        let den = (self.l2 * self.r2).sqrt();
        if den <= 1e-12 {
            return 0.0;
        }
        let corr = (self.lr / den).clamp(-1.0, 1.0);
        90.0 - corr.acos().to_degrees()
    }

    pub(crate) fn report(
        &self,
        present: bool,
        threshold: f32,
        valid_bits: Option<f32>,
        speed: f32,
    ) -> SignalReport {
        let level_left_dbfs = db_power(self.l2);
        let level_right_dbfs = db_power(self.r2);
        SignalReport {
            present,
            level_left_dbfs,
            level_right_dbfs,
            balance_db: level_left_dbfs - level_right_dbfs,
            phase_error_deg: self.phase_error_deg(),
            noise_floor_dbfs: db_power(self.noise_power()),
            snr_db: self.snr_db(),
            valid_bits_pct: valid_bits.map(|v| v * 100.0),
            threshold,
            speed,
        }
    }
}
