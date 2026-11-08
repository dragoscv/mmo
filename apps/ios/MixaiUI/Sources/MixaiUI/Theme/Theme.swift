import CoreText
import MixaiCore
import SwiftUI

/// Dark-first cinematic theme on top of the generated `Tokens` (packages/design-tokens → MixaiCore/Theme/Tokens.swift).
public enum Theme {
    public static let background = Tokens.Dark.background
    public static let foreground = Tokens.Dark.foreground
    public static let card = Tokens.Dark.card
    public static let muted = Tokens.Dark.muted
    public static let mutedForeground = Tokens.Dark.mutedForeground
    public static let primary = Tokens.Dark.primary
    public static let primaryForeground = Tokens.Dark.primaryForeground
    public static let border = Tokens.Dark.border
    public static let destructive = Tokens.Dark.destructive
    public static let success = Tokens.Dark.success

    public static let brandGradient = LinearGradient(colors: [Tokens.Brand.violetDark, Tokens.Brand.magentaDark], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// Bottom scrim over hero art so text stays readable (WCAG on any backdrop).
    public static let heroScrim = LinearGradient(
        stops: [.init(color: .clear, location: 0.35), .init(color: background.opacity(0.75), location: 0.75), .init(color: background, location: 1)],
        startPoint: .top, endPoint: .bottom)

    public static func heading(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .custom("Space Grotesk", size: size, relativeTo: size > 24 ? .largeTitle : .title3).weight(weight)
    }

    public static func body(_ size: CGFloat = 16, weight: Font.Weight = .regular) -> Font {
        .custom("Inter", size: size, relativeTo: .body).weight(weight)
    }

    /// Registers the bundled variable fonts of the host app (also listed in UIAppFonts; this covers both).
    public static func registerFonts() {
        for name in ["SpaceGrotesk-Variable", "Inter-Variable"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

extension View {
    /// Rounded "glass" card used for chips and panels.
    public func glassCard(cornerRadius: CGFloat = 16) -> some View {
        self.glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
    }
}
