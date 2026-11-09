import MixaiCore
import SwiftUI

/// MixAI Live palette. Every colour comes from the generated design tokens (`MixaiCore/Theme/Tokens.swift`,
/// `pnpm tokens:build`); the app is dark-first like the stage it is used on.
enum LiveTheme {
    static let background = Tokens.Dark.background
    static let surface = Tokens.Dark.card
    static let raised = Tokens.Dark.secondary
    static let foreground = Tokens.Dark.foreground
    static let muted = Tokens.Dark.mutedForeground
    static let border = Tokens.Dark.border
    static let accent = Tokens.Dark.primary
    static let accentForeground = Tokens.Dark.primaryForeground
    static let danger = Tokens.Dark.destructive
    static let dangerForeground = Tokens.Dark.destructiveForeground
    static let success = Tokens.Dark.success
    static let warning = Tokens.Dark.warning
    static let info = Tokens.Dark.info
    static let brand = Tokens.Brand.violet

    /// Meter colour by level: green, amber above -9 dBFS, red above -1 dBFS.
    static func meter(_ db: Float) -> Color { db > -1 ? danger : db > -9 ? warning : success }

    /// Tuner colour by cents off.
    static func tune(_ cents: Float) -> Color { abs(cents) <= 5 ? success : abs(cents) <= 20 ? warning : danger }
}

extension View {
    /// Rounded card on the surface colour.
    func liveCard(padding: CGFloat = 14) -> some View {
        self.padding(padding)
            .background(LiveTheme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(LiveTheme.border))
    }
}

enum LiveFormat {
    static func db(_ v: Float) -> String { v <= -60 ? "-\u{221E}" : String(format: "%+.1f dB", v) }
    static func percent(_ v: Float) -> String { String(format: "%.0f%%", v * 100) }
    static func cents(_ v: Float) -> String { String(format: "%+.0f", v) }
}
