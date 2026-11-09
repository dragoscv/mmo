//! Colour constants and theme palettes.
//!
//! Deck colours mirror `packages/design-tokens/src/tokens.ts` → `BRAND.deckA..deckD`
//! ("Deck colours for MixAI Decks — kept regardless of accent (D9)"). They are COPIED by hand:
//! when tokens.ts changes, update the hex values below (the `deck_colours_match_design_tokens`
//! test fails until you do). A generated Rust mirror from the design-tokens build would replace
//! this copy; it is not part of this crate.
//!
//! Theme neutrals approximate the tokens' OKLCH `dark` / `light` background, card and foreground
//! values in sRGB. Render targets are UNORM (not sRGB), so these values are written as-is.

/// Linear RGBA in 0..1 (written straight into a UNORM target).
pub type Rgba = [f32; 4];

/// `BRAND.deckA` in tokens.ts.
pub const DECK_A_HEX: u32 = 0x22d3ee;
/// `BRAND.deckB` in tokens.ts.
pub const DECK_B_HEX: u32 = 0xff4fa3;
/// `BRAND.deckC` in tokens.ts.
pub const DECK_C_HEX: u32 = 0xa3ff4f;
/// `BRAND.deckD` in tokens.ts.
pub const DECK_D_HEX: u32 = 0xffb14f;

/// Converts `0xRRGGBB` to an opaque [`Rgba`].
pub const fn hex(v: u32) -> Rgba {
    [
        ((v >> 16) & 0xff) as f32 / 255.0,
        ((v >> 8) & 0xff) as f32 / 255.0,
        (v & 0xff) as f32 / 255.0,
        1.0,
    ]
}

/// Deck colours A..D (D9: independent of the user accent).
pub const DECK_COLORS: [Rgba; 4] = [
    hex(DECK_A_HEX),
    hex(DECK_B_HEX),
    hex(DECK_C_HEX),
    hex(DECK_D_HEX),
];

/// Light or dark UI theme.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Theme {
    /// Dark theme (default for DJ booths).
    #[default]
    Dark,
    /// Light theme.
    Light,
}

/// Resolved colours for one theme.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    /// Clear colour behind every view.
    pub background: Rgba,
    /// Panel fill behind a waveform / scope.
    pub panel: Rgba,
    /// Thin structural lines (crosshair, meter track).
    pub grid: Rgba,
    /// Beat line.
    pub beat: Rgba,
    /// Downbeat (bar) line.
    pub downbeat: Rgba,
    /// Playhead (opaque).
    pub playhead: Rgba,
    /// Low band (RGB style).
    pub low: Rgba,
    /// Mid band (RGB style).
    pub mid: Rgba,
    /// High band (RGB style).
    pub high: Rgba,
}

impl Palette {
    /// Palette for `theme`.
    pub const fn for_theme(theme: Theme) -> Self {
        match theme {
            Theme::Dark => Self {
                background: [0.043, 0.047, 0.063, 1.0],
                panel: [0.075, 0.082, 0.106, 1.0],
                grid: [1.0, 1.0, 1.0, 0.12],
                beat: [1.0, 1.0, 1.0, 0.30],
                downbeat: [1.0, 1.0, 1.0, 0.80],
                // tokens dark.foreground: warm ivory, never pure white.
                playhead: [0.957, 0.945, 0.918, 1.0],
                low: [0.93, 0.26, 0.27, 1.0],
                mid: [0.33, 0.85, 0.40, 1.0],
                high: [0.35, 0.60, 1.0, 1.0],
            },
            Theme::Light => Self {
                background: [0.965, 0.965, 0.976, 1.0],
                panel: [0.918, 0.922, 0.941, 1.0],
                grid: [0.0, 0.0, 0.0, 0.12],
                beat: [0.0, 0.0, 0.0, 0.28],
                downbeat: [0.0, 0.0, 0.0, 0.75],
                playhead: [0.078, 0.078, 0.102, 1.0],
                low: [0.84, 0.18, 0.20, 1.0],
                mid: [0.16, 0.66, 0.26, 1.0],
                high: [0.18, 0.42, 0.92, 1.0],
            },
        }
    }
}

/// Returns `c` with alpha `a`.
pub const fn with_alpha(c: Rgba, a: f32) -> Rgba {
    [c[0], c[1], c[2], a]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deck_colours_match_design_tokens() {
        let rel = "packages/design-tokens/src/tokens.ts";
        let found = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .map(|a| a.join(rel))
            .find(|p| p.is_file());
        let Some(src) = found.and_then(|p| std::fs::read_to_string(p).ok()) else {
            eprintln!("SKIP: {rel} not found above the crate (built outside the mmo repo)");
            return;
        };
        for (key, v) in [
            ("deckA", DECK_A_HEX),
            ("deckB", DECK_B_HEX),
            ("deckC", DECK_C_HEX),
            ("deckD", DECK_D_HEX),
        ] {
            let needle = format!("{key}: \"#{v:06x}\"");
            assert!(
                src.contains(&needle),
                "tokens.ts no longer contains `{needle}`: update colors.rs"
            );
        }
    }

    #[test]
    fn hex_converts() {
        assert_eq!(hex(0xff0080), [1.0, 0.0, 128.0 / 255.0, 1.0]);
    }
}
