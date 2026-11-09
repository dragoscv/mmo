import MixaiCore
import SwiftUI

/// MixAI Decks palette. Every colour comes from the generated design tokens
/// (`MixaiCore/Theme/Tokens.swift`, `pnpm tokens:build`); the app is dark-first.
enum DecksTheme {
    static let background = Tokens.Dark.background
    static let surface = Tokens.Dark.card
    static let raised = Tokens.Dark.secondary
    static let foreground = Tokens.Dark.foreground
    static let muted = Tokens.Dark.mutedForeground
    static let border = Tokens.Dark.border
    static let accent = Tokens.Dark.primary
    static let accentForeground = Tokens.Dark.primaryForeground
    static let danger = Tokens.Dark.destructive
    static let success = Tokens.Dark.success
    static let warning = Tokens.Dark.warning
    static let info = Tokens.Dark.info

    static let decks: [Color] = [Tokens.Brand.deckA, Tokens.Brand.deckB, Tokens.Brand.deckC, Tokens.Brand.deckD]

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

    // 0xRRGGBB versions for the Rust renderer markers (resolved once from the tokens).
    @MainActor static let deckRGB: [UInt32] = decks.map(\.rgb24)
    @MainActor static let hotCueRGB: [UInt32] = hotCues.map(\.rgb24)
    @MainActor static let cueRGB: UInt32 = Tokens.Dark.warning.rgb24
}

extension Color {
    /// `0xRRGGBB` of the colour in sRGB (for FFI calls that take packed colours).
    var rgb24: UInt32 {
        let r = resolve(in: EnvironmentValues())
        func byte(_ v: Float) -> UInt32 { UInt32((min(max(v, 0), 1) * 255).rounded()) }
        return (byte(r.red) << 16) | (byte(r.green) << 8) | byte(r.blue)
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
