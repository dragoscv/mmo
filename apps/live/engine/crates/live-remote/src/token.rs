//! Pairing tokens: 128-bit OS randomness, hex encoded, compared in constant time.

/// A fresh 32-hex-char token from the OS RNG.
pub fn new_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random number generator unavailable");
    let mut s = String::with_capacity(32);
    for x in b {
        s.push(char::from_digit(u32::from(x >> 4), 16).unwrap_or('0'));
        s.push(char::from_digit(u32::from(x & 0x0f), 16).unwrap_or('0'));
    }
    s
}

/// Constant-time string equality (length is not secret: every token has 32 chars).
pub fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.bytes()
        .zip(b.bytes())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_32_hex_chars_and_unique() {
        let a = new_token();
        let b = new_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn ct_eq_matches_only_identical_strings() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "abcd"));
        assert!(ct_eq("", ""));
    }
}
