//! Fixed-size sample history.

pub(crate) struct Ring {
    buf: Vec<f32>,
    pos: usize,
}

impl Ring {
    pub fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], pos: 0 }
    }

    #[inline]
    pub fn push(&mut self, x: f32) {
        self.buf[self.pos] = x;
        self.pos += 1;
        if self.pos == self.buf.len() {
            self.pos = 0;
        }
    }

    /// Writes the latest `out.len()` samples (oldest first). `out.len()` must not exceed the ring length.
    pub fn copy_latest(&self, out: &mut [f32]) {
        let n = out.len().min(self.buf.len());
        let start = (self.pos + self.buf.len() - n) % self.buf.len();
        let first = (self.buf.len() - start).min(n);
        out[..first].copy_from_slice(&self.buf[start..start + first]);
        out[first..n].copy_from_slice(&self.buf[..n - first]);
    }

    pub fn clear(&mut self) {
        self.buf.iter_mut().for_each(|x| *x = 0.0);
        self.pos = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_latest_returns_the_newest_samples_in_order_across_the_wrap() {
        let mut r = Ring::new(5);
        for i in 0..8 {
            r.push(i as f32);
        }
        let mut out = [0.0; 4];
        r.copy_latest(&mut out);
        assert_eq!(out, [4.0, 5.0, 6.0, 7.0]);
    }
}
