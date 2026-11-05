import CoreText
import SwiftUI

/// Dark-first cinematic theme on top of the generated `Tokens` (packages/design-tokens).
enum Theme {
    static let background = Tokens.Dark.background
    static let foreground = Tokens.Dark.foreground
    static let card = Tokens.Dark.card
    static let muted = Tokens.Dark.muted
    static let mutedForeground = Tokens.Dark.mutedForeground
    static let primary = Tokens.Dark.primary
    static let primaryForeground = Tokens.Dark.primaryForeground
    static let border = Tokens.Dark.border
    static let destructive = Tokens.Dark.destructive
    static let success = Tokens.Dark.success

    static let brandGradient = LinearGradient(colors: [Tokens.Brand.violetDark, Tokens.Brand.magentaDark], startPoint: .topLeading, endPoint: .bottomTrailing)

    /// Bottom scrim over hero art so text stays readable (WCAG on any backdrop).
    static let heroScrim = LinearGradient(
        stops: [.init(color: .clear, location: 0.35), .init(color: background.opacity(0.75), location: 0.75), .init(color: background, location: 1)],
        startPoint: .top, endPoint: .bottom)

    static func heading(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .custom("Space Grotesk", size: size, relativeTo: size > 24 ? .largeTitle : .title3).weight(weight)
    }

    static func body(_ size: CGFloat = 16, weight: Font.Weight = .regular) -> Font {
        .custom("Inter", size: size, relativeTo: .body).weight(weight)
    }

    /// Registers the bundled variable fonts (also listed in UIAppFonts; this covers both).
    static func registerFonts() {
        for name in ["SpaceGrotesk-Variable", "Inter-Variable"] {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

extension View {
    /// Rounded "glass" card used for chips and panels.
    func glassCard(cornerRadius: CGFloat = 16) -> some View {
        self.glassEffect(.regular, in: .rect(cornerRadius: cornerRadius))
    }
}
