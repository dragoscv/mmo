//! Flush-to-zero for the audio path.
//!
//! When the input goes to exact digital silence, filter and envelope states decay into the
//! subnormal range and stay there (rounding keeps the smallest subnormal alive). Arithmetic on
//! subnormals is done in microcode on x86: measured on this engine, a silent input cost 11–27×
//! more CPU than the same file with −120 dB of noise. [`NoDenormals`] turns on the CPU's
//! flush-to-zero mode for a scope (x86-64: MXCSR FTZ + DAZ; AArch64: FPCR.FZ) and restores the
//! previous mode when dropped, so only DSP code runs with it.
//!
//! The mode changes only results that are (or come from) subnormals, below −750 dBFS.
//!
//! Limits, stated plainly:
//! * Rust assumes the default floating-point environment. Code compiled for the default mode
//!   runs here with another one, which the language does not promise to support: the compiler
//!   may fold an operation at compile time (default mode) or move one across the two mode
//!   switches. Either can only change a value that is or becomes subnormal, which is the
//!   range this guard exists to throw away; the DSP code has no subnormal constants.
//! * 32-bit ARM and 32-bit x86 get the no-op: on those targets only the per-effect
//!   `undenormal()` offsets (delay, reverb) protect against the slow path. The Android
//!   library is built for arm64-v8a and x86_64 by default.

#[cfg(target_arch = "x86_64")]
mod arch {
    use core::arch::asm;

    /// MXCSR: flush-to-zero (bit 15) and denormals-are-zero (bit 6).
    const MASK: u32 = 0x8040;

    #[inline]
    pub fn read() -> u64 {
        let mut w: u32 = 0;
        // SAFETY: `stmxcsr` writes the 32-bit MXCSR to the address given, a live local.
        unsafe {
            asm!("stmxcsr dword ptr [{}]", in(reg) &raw mut w, options(nostack, preserves_flags));
        }
        u64::from(w)
    }

    #[inline]
    pub fn write(w: u64) {
        let w = w as u32;
        // SAFETY: `ldmxcsr` loads MXCSR from a live local. The value is one `read` returned,
        // with at most the two flush bits changed: exception masks and rounding stay as they were.
        // (No `preserves_flags`: the sticky exception flags of MXCSR are rewritten too.)
        unsafe {
            asm!("ldmxcsr dword ptr [{}]", in(reg) &raw const w, options(nostack, readonly));
        }
    }

    #[inline]
    pub fn flushing(w: u64) -> u64 {
        w | u64::from(MASK)
    }
}

#[cfg(target_arch = "aarch64")]
mod arch {
    use core::arch::asm;

    /// FPCR.FZ: flush-to-zero.
    const MASK: u64 = 1 << 24;

    #[inline]
    pub fn read() -> u64 {
        let w: u64;
        // SAFETY: reads the floating-point control register into a general register.
        unsafe {
            asm!("mrs {}, fpcr", out(reg) w, options(nomem, nostack, preserves_flags));
        }
        w
    }

    #[inline]
    pub fn write(w: u64) {
        // SAFETY: writes back a value `read` returned, with at most the FZ bit changed.
        unsafe {
            asm!("msr fpcr, {}", in(reg) w, options(nomem, nostack, preserves_flags));
        }
    }

    #[inline]
    pub fn flushing(w: u64) -> u64 {
        w | MASK
    }
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
mod arch {
    #[inline]
    pub fn read() -> u64 {
        0
    }

    #[inline]
    pub fn write(_w: u64) {}

    #[inline]
    pub fn flushing(w: u64) -> u64 {
        w
    }
}

/// Flush-to-zero while this value lives; the previous mode comes back when it is dropped.
/// Per thread, allocation-free, a few nanoseconds: `Core::render` takes one per block.
///
/// The mode belongs to the thread, so the guard cannot be sent to another one (it is neither
/// `Send` nor `Sync`): drop it on the thread that created it, and drop nested guards in
/// reverse order.
#[must_use = "flush-to-zero lasts only while the guard is alive"]
pub struct NoDenormals {
    saved: u64,
    _this_thread: core::marker::PhantomData<*const ()>,
}

impl NoDenormals {
    /// Switch the calling thread to flush-to-zero until the returned guard is dropped.
    #[inline]
    pub fn enter() -> Self {
        let saved = arch::read();
        arch::write(arch::flushing(saved));
        Self {
            saved,
            _this_thread: core::marker::PhantomData,
        }
    }
}

impl Drop for NoDenormals {
    #[inline]
    fn drop(&mut self) {
        arch::write(self.saved);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::hint::black_box;

    #[test]
    fn subnormals_flush_inside_the_scope_only() {
        // The product is pinned too, so the multiply cannot move across a mode switch.
        let halve = |x: f32| black_box(black_box(x) * black_box(0.5f32));
        let before = halve(f32::MIN_POSITIVE);
        let inside = {
            let _flush = NoDenormals::enter();
            let nested = {
                let _again = NoDenormals::enter();
                halve(f32::MIN_POSITIVE)
            };
            // Leaving the inner scope must not switch the outer one off.
            (nested, halve(f32::MIN_POSITIVE))
        };
        let after = halve(f32::MIN_POSITIVE);
        assert!(before.is_subnormal(), "default mode keeps subnormals");
        assert!(after.is_subnormal(), "the scope must restore the mode");
        if cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
            assert_eq!(inside, (0.0, 0.0));
        }
    }

    /// Why a decaying state settles just above the subnormal range instead of at zero: a
    /// one-pole update `y += c * (0 − y)` is smaller than the smallest normal float once
    /// `y < MIN_POSITIVE / c`, flushes to zero, and `y` stops moving. The value is a normal
    /// float (no microcode), around 1e-37 for the coefficients used here.
    #[test]
    fn a_one_pole_state_stops_just_above_the_subnormal_range() {
        if !cfg!(any(target_arch = "x86_64", target_arch = "aarch64")) {
            return;
        }
        let _flush = NoDenormals::enter();
        let c = black_box(0.1f32);
        let mut y = black_box(1.0f32);
        for _ in 0..20_000 {
            y += c * (0.0 - y);
        }
        assert!(y.is_normal() && y < f32::MIN_POSITIVE / c * 1.01, "{y:e}");
    }
}
