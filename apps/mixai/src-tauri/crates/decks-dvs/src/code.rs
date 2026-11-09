//! Position codes for absolute mode.
//!
//! A position code assigns one bit to every carrier cycle. Any `window_bits()` consecutive bits
//! identify the cycle uniquely, so after reading that many cycles the decoder knows where the
//! needle is. The decoder only needs [`PositionCode`]; vendor codes can be plugged in later
//! without touching the DSP.

use std::fmt;

/// A per-cycle bit sequence with a window lookup.
///
/// Window convention: bit `i` of the window value is the bit of cycle `k + i`, where `k` is the
/// value returned by [`PositionCode::lookup`].
pub trait PositionCode: Send + Sync + fmt::Debug {
    /// Name shown in the UI.
    fn name(&self) -> &'static str;
    /// Carrier frequency (Hz) at nominal speed; one bit per carrier cycle.
    fn carrier_hz(&self) -> f64;
    /// Number of consecutive bits that identify a position (8..=32).
    fn window_bits(&self) -> u32;
    /// Length of the (cyclic) sequence in cycles.
    fn len_cycles(&self) -> u32;
    /// Bit of cycle `cycle` (taken modulo `len_cycles`).
    fn bit(&self, cycle: u32) -> bool;
    /// First cycle of the window whose bits form `window`, if the window occurs.
    fn lookup(&self, window: u32) -> Option<u32>;
    /// Carrier amplitude of a 0 bit relative to a 1 bit (0 < z < 1).
    fn zero_level(&self) -> f32;
}

/// MixAI timecode carrier frequency.
pub const MIXAI_CARRIER_HZ: f64 = 1000.0;
/// MixAI LFSR length: 20 bits → 2^20 − 1 = 1 048 575 cycles ≈ 17 min 28 s at 1 kHz.
pub const MIXAI_LFSR_BITS: u32 = 20;
/// MixAI LFSR feedback tap: s[k+20] = s[k+17] ⊕ s[k], i.e. characteristic polynomial
/// x^20 + x^17 + 1 (published maximal-length tap pair 20,17; reciprocal of x^20 + x^3 + 1).
pub const MIXAI_LFSR_TAP: u32 = 17;
/// MixAI LFSR seed (any non-zero 20-bit value works; this one is ours).
pub const MIXAI_LFSR_SEED: u32 = 0x9E3B5;
/// Amplitude of a 0 bit relative to a 1 bit (AM depth 40 %).
pub const MIXAI_ZERO_LEVEL: f32 = 0.6;

/// The MixAI timecode: 20-bit maximal-length LFSR, one bit per 1 kHz carrier cycle.
///
/// Construction builds a 4 MiB lookup table (`2^20` × `u32`) once; share one instance between
/// decks with `Arc`.
pub struct MixAiCode {
    bits: Vec<u64>,
    table: Vec<u32>,
    len: u32,
}

impl MixAiCode {
    /// Generate the sequence and its window → cycle table.
    pub fn new() -> Self {
        let n = MIXAI_LFSR_BITS;
        let mask: u32 = (1 << n) - 1;
        let len: u32 = mask;
        let mut bits = vec![0u64; (len as usize).div_ceil(64)];
        let mut table = vec![u32::MAX; 1usize << n];
        // `state` bit i == s[k + i], so the state at step k *is* the window starting at k.
        let mut state = MIXAI_LFSR_SEED & mask;
        for k in 0..len {
            table[state as usize] = k;
            if state & 1 == 1 {
                bits[(k / 64) as usize] |= 1u64 << (k % 64);
            }
            let feedback = (state ^ (state >> MIXAI_LFSR_TAP)) & 1;
            state = (state >> 1) | (feedback << (n - 1));
        }
        Self { bits, table, len }
    }

    /// Number of distinct windows in the table. Equals `len_cycles()` iff the LFSR is maximal.
    pub fn distinct_windows(&self) -> usize {
        self.table.iter().filter(|&&v| v != u32::MAX).count()
    }
}

impl Default for MixAiCode {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for MixAiCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MixAiCode")
            .field("len_cycles", &self.len)
            .field("window_bits", &MIXAI_LFSR_BITS)
            .finish_non_exhaustive()
    }
}

impl PositionCode for MixAiCode {
    fn name(&self) -> &'static str {
        "MixAI"
    }

    fn carrier_hz(&self) -> f64 {
        MIXAI_CARRIER_HZ
    }

    fn window_bits(&self) -> u32 {
        MIXAI_LFSR_BITS
    }

    fn len_cycles(&self) -> u32 {
        self.len
    }

    fn bit(&self, cycle: u32) -> bool {
        let c = cycle % self.len;
        (self.bits[(c / 64) as usize] >> (c % 64)) & 1 == 1
    }

    fn lookup(&self, window: u32) -> Option<u32> {
        self.table
            .get(window as usize)
            .copied()
            .filter(|&v| v != u32::MAX)
    }

    fn zero_level(&self) -> f32 {
        MIXAI_ZERO_LEVEL
    }
}
