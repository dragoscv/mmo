//! Fixed-capacity circular buffer with fractional (Hermite) reads. Allocated once.

pub struct DelayLine {
    buf: Vec<f32>,
    mask: usize,
    w: usize,
}

impl DelayLine {
    /// Capacity is rounded up to a power of two >= `max_samples + 4`.
    pub fn new(max_samples: usize) -> Self {
        let cap = (max_samples + 4).next_power_of_two();
        Self {
            buf: vec![0.0; cap],
            mask: cap - 1,
            w: 0,
        }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len() - 4
    }

    #[inline]
    pub fn push(&mut self, x: f32) {
        self.buf[self.w] = x;
        self.w = (self.w + 1) & self.mask;
    }

    /// Sample written `delay` samples ago (integer, `delay >= 1`).
    #[inline]
    pub fn tap(&self, delay: usize) -> f32 {
        self.buf[(self.w.wrapping_sub(delay)) & self.mask]
    }

    /// Fractional delay read with 4-point Hermite interpolation (`delay >= 1`).
    #[inline]
    pub fn read(&self, delay: f32) -> f32 {
        let d = delay.clamp(1.0, self.capacity() as f32 - 2.0);
        let di = d as usize;
        let f = d - di as f32;
        let xm1 = self.tap(di - 1);
        let x0 = self.tap(di);
        let x1 = self.tap(di + 1);
        let x2 = self.tap(di + 2);
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        ((c3 * f + c2) * f + c1) * f + x0
    }

    pub fn clear(&mut self) {
        self.buf.fill(0.0);
        self.w = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_tap_returns_history() {
        let mut d = DelayLine::new(16);
        for i in 0..10 {
            d.push(i as f32);
        }
        assert_eq!(d.tap(1), 9.0);
        assert_eq!(d.tap(4), 6.0);
        assert!((d.read(4.0) - 6.0).abs() < 1e-6);
        assert!((d.read(4.5) - 5.5).abs() < 1e-4);
    }
}
