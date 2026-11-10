import MixaiCore
import Observation
import SwiftUI

/// Runtime palette of MixAI Decks (WP19-34): dark / light roles from the generated design tokens
/// (`MixaiCore/Theme/Tokens.swift`, `pnpm tokens:build`), an accent hue (OKLCH, same maths as
/// packages/design-tokens `oklchToHex`) and the colour overrides of an installed `.mixaipack` skin
/// (already validated and resolved to sRGB by decks-packs, so Swift never parses `oklch(...)`).
/// Views read it through the `DecksTheme` statics; being `@Observable`, a skin change redraws them.
@Observable
final class DecksPalette: @unchecked Sendable {
    /// The one palette the app draws with (mutated on the main actor only).
    static let shared = DecksPalette()

    private(set) var dark = true
    /// Named accent (`violet`, `magenta`, `cyan`, `emerald`, `amber`, `rose`).
    private(set) var accentName = "violet"
    /// Pack token key (`primary`, `background`, `deck-a`, …) → colour.
    private(set) var overrides: [String: Color] = [:]

    static let accentNames = ["violet", "magenta", "cyan", "emerald", "amber", "rose"]

    @MainActor func apply(dark: Bool, accent: String, overrides: [String: Color]) {
        self.dark = dark
        self.accentName = Self.accentNames.contains(accent) ? accent : "violet"
        self.overrides = overrides
    }

    private func pick(_ key: String, dark d: Color, light l: Color) -> Color { overrides[key] ?? (dark ? d : l) }

    var background: Color { pick("background", dark: Tokens.Dark.background, light: Tokens.Light.background) }
    var surface: Color { pick("card", dark: Tokens.Dark.card, light: Tokens.Light.card) }
    var raised: Color { pick("secondary", dark: Tokens.Dark.secondary, light: Tokens.Light.secondary) }
    var foreground: Color { pick("foreground", dark: Tokens.Dark.foreground, light: Tokens.Light.foreground) }
    var muted: Color { pick("muted-foreground", dark: Tokens.Dark.mutedForeground, light: Tokens.Light.mutedForeground) }
    var border: Color { pick("border", dark: Tokens.Dark.border, light: Tokens.Light.border) }
    var danger: Color { pick("destructive", dark: Tokens.Dark.destructive, light: Tokens.Light.destructive) }
    var success: Color { pick("success", dark: Tokens.Dark.success, light: Tokens.Light.success) }
    var warning: Color { pick("warning", dark: Tokens.Dark.warning, light: Tokens.Light.warning) }
    var info: Color { dark ? Tokens.Dark.info : Tokens.Light.info }

    /// Primary / tint: the token primary for violet, otherwise the accent hue at the primary's lightness.
    var accent: Color {
        if let o = overrides["primary"] ?? overrides["accent"] { return o }
        if accentName == "violet" { return dark ? Tokens.Dark.primary : Tokens.Light.primary }
        return DecksOklab.color(l: dark ? 0.70 : 0.52, c: dark ? 0.17 : 0.21, h: Self.hue(accentName))
    }

    var accentForeground: Color {
        if let o = overrides["primary-foreground"] { return o }
        return dark ? Tokens.Dark.primaryForeground : Tokens.Light.primaryForeground
    }

    /// Deck identity colours: brand-fixed unless a pack sets `deck-a…deck-d`.
    var decks: [Color] {
        let brand = [Tokens.Brand.deckA, Tokens.Brand.deckB, Tokens.Brand.deckC, Tokens.Brand.deckD]
        return ["deck-a", "deck-b", "deck-c", "deck-d"].enumerated().map { i, k in overrides[k] ?? brand[i] }
    }

    static func hue(_ name: String) -> Double {
        switch name {
        case "magenta": Tokens.AccentHue.magenta
        case "cyan": Tokens.AccentHue.cyan
        case "emerald": Tokens.AccentHue.emerald
        case "amber": Tokens.AccentHue.amber
        case "rose": Tokens.AccentHue.rose
        default: Tokens.AccentHue.violet
        }
    }
}

/// OKLCH → sRGB, identical constants to packages/design-tokens `oklchToHex`.
enum DecksOklab {
    static func color(l: Double, c: Double, h: Double) -> Color {
        let hr = h * .pi / 180
        let a = c * cos(hr), b = c * sin(hr)
        let l1 = l + 0.3963377774 * a + 0.2158037573 * b
        let m1 = l - 0.1055613458 * a - 0.0638541728 * b
        let s1 = l - 0.0894841775 * a - 1.291485548 * b
        let ll = l1 * l1 * l1, mm = m1 * m1 * m1, ss = s1 * s1 * s1
        func gam(_ x: Double) -> Double {
            let v = min(max(x, 0), 1)
            return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1 / 2.4) - 0.055
        }
        return Color(
            .sRGB,
            red: gam(4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss),
            green: gam(-1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss),
            blue: gam(-0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss),
            opacity: 1
        )
    }
}

/// MixAI Decks palette. The static API every view uses is unchanged; the values now come from the
/// observable [DecksPalette.shared] (skin mode, accent, pack overrides).
enum DecksTheme {
    private static var p: DecksPalette { DecksPalette.shared }

    static var background: Color { p.background }
    static var surface: Color { p.surface }
    static var raised: Color { p.raised }
    static var foreground: Color { p.foreground }
    static var muted: Color { p.muted }
    static var border: Color { p.border }
    static var accent: Color { p.accent }
    static var accentForeground: Color { p.accentForeground }
    static var danger: Color { p.danger }
    static var success: Color { p.success }
    static var warning: Color { p.warning }
    static var info: Color { p.info }

    static var decks: [Color] { p.decks }

    static func deck(_ index: Int) -> Color { decks[((index % 4) + 4) % 4] }

    /// Hot cue pad colours 1…8 (token chart palette, then the deck colours).
    static let hotCues: [Color] = [
        Tokens.Dark.chart1, Tokens.Dark.chart2, Tokens.Dark.chart3, Tokens.Dark.chart4,
        Tokens.Dark.chart5, Tokens.Brand.deckC, Tokens.Brand.deckD, Tokens.Brand.magenta,
    ]

    /// Camelot key colour (`8A` → minor wheel slot 8).
    static func key(_ camelot: String?) -> Color {
        guard let camelot, let mode = camelot.last, let n = Int(camelot.dropLast()), (1...12).contains(n) else {
            return muted
        }
        return mode == "B" ? Tokens.Key.major[n - 1] : Tokens.Key.minor[n - 1]
    }

    // 0xRRGGBB versions for the Rust renderer markers.
    @MainActor static var deckRGB: [UInt32] { decks.map(\.rgb24) }
    @MainActor static let hotCueRGB: [UInt32] = hotCues.map(\.rgb24)
    @MainActor static var cueRGB: UInt32 { warning.rgb24 }
}

extension Color {
    /// `0xRRGGBB` of the colour in sRGB (for FFI calls that take packed colours).
    var rgb24: UInt32 {
        let r = resolve(in: EnvironmentValues())
        func byte(_ v: Float) -> UInt32 { UInt32((min(max(v, 0), 1) * 255).rounded()) }
        return (byte(r.red) << 16) | (byte(r.green) << 8) | byte(r.blue)
    }

    /// Colour from a packed `0xRRGGBB` (decks-ffi `PackColor.rgb`).
    init(rgb24: UInt32, opacity: Double = 1) {
        self.init(
            .sRGB,
            red: Double((rgb24 >> 16) & 0xff) / 255,
            green: Double((rgb24 >> 8) & 0xff) / 255,
            blue: Double(rgb24 & 0xff) / 255,
            opacity: opacity
        )
    }
}

enum DecksFormat {
    /// `m:ss` for a duration / position in seconds.
    static func time(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let s = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    static func bpm(_ bpm: Double?) -> String {
        guard let bpm, bpm > 0 else { return "—" }
        return String(format: "%.1f", bpm)
    }

    static func percent(_ ratio: Double) -> String {
        String(format: "%+.1f%%", (ratio - 1) * 100)
    }
}
