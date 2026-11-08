import CoreText
import MixaiCore
import SwiftUI

/// Ten-foot theme on the shared generated `Tokens` (packages/design-tokens → MixaiCore/Theme/Tokens.swift).
enum TVTheme {
    static let background = Tokens.Dark.background
    static let foreground = Tokens.Dark.foreground
    static let card = Tokens.Dark.card
    static let muted = Tokens.Dark.muted
    static let mutedForeground = Tokens.Dark.mutedForeground
    static let primary = Tokens.Dark.primary
    static let destructive = Tokens.Dark.destructive
    static let success = Tokens.Dark.success

    static let brandGradient = LinearGradient(colors: [Tokens.Brand.violetDark, Tokens.Brand.magentaDark], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// Left + bottom scrim over hero art so text stays readable on any backdrop.
    static let heroScrimBottom = LinearGradient(
        stops: [.init(color: .clear, location: 0.3), .init(color: background.opacity(0.8), location: 0.78), .init(color: background, location: 1)],
        startPoint: .top, endPoint: .bottom)
    static let heroScrimLeading = LinearGradient(
        stops: [.init(color: background.opacity(0.9), location: 0), .init(color: background.opacity(0.4), location: 0.45), .init(color: .clear, location: 0.7)],
        startPoint: .leading, endPoint: .trailing)

    static func heading(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .custom("Space Grotesk", size: size, relativeTo: size > 40 ? .largeTitle : .title2).weight(weight)
    }

    static func body(_ size: CGFloat = 29, weight: Font.Weight = .regular) -> Font {
        .custom("Inter", size: size, relativeTo: .body).weight(weight)
    }

    static func registerFonts() {
        for name in ["SpaceGrotesk-Variable", "Inter-Variable"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}
