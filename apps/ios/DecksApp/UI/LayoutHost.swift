import DecksFFI
import SwiftUI

/// Zero-scroll layout host (WP19-34, docs/decks/layouts.md "Native apps"): measures the space, asks the
/// Rust solver (`layoutSolve`, the same one Android / Desktop use) for rects + tiers, positions every
/// panel by its rect and shows what does not fit — or what this app does not have — as tabs in the dock.
/// Nothing here scrolls.
struct LayoutHost<PanelContent: View>: View {
    let layoutJson: String
    /// Panels this app renders; the rest always go to the dock.
    var available: [LayoutPanel] = LayoutHostDefaults.native
    @ViewBuilder let panel: (LayoutPanel, LayoutTier) -> PanelContent

    var body: some View {
        GeometryReader { geo in
            let sol = solve(geo.size)
            let hostIndex = sol.dock.flatMap { d in sol.placements.firstIndex { Self.same($0.rect, d) } }
            let host = hostIndex.map { sol.placements[$0] }
            ZStack(alignment: .topLeading) {
                ForEach(Array(sol.placements.indices), id: \.self) { i in
                    if i != hostIndex {
                        let p = sol.placements[i]
                        panel(p.panel, p.tier)
                            .frame(width: CGFloat(p.rect.w), height: CGFloat(p.rect.h))
                            .offset(x: CGFloat(p.rect.x), y: CGFloat(p.rect.y))
                    }
                }
                if let dock = sol.dock {
                    DockView(tabs: (host.map { [$0.panel] } ?? []) + sol.docked, tier: host?.tier ?? .icon,
                             available: available, panel: panel)
                        .frame(width: CGFloat(dock.w), height: CGFloat(dock.h))
                        .offset(x: CGFloat(dock.x), y: CGFloat(dock.y))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .topLeading)
        }
    }

    private func solve(_ size: CGSize) -> LayoutSolution {
        (try? layoutSolve(layoutJson: layoutJson, w: Double(size.width), h: Double(size.height), available: available))
            ?? LayoutSolution(placements: [], docked: [], dock: nil)
    }

    private static func same(_ a: LayoutRect, _ b: LayoutRect) -> Bool {
        a.x == b.x && a.y == b.y && a.w == b.w && a.h == b.h
    }
}

enum LayoutHostDefaults {
    /// Two decks, mixer, crossfader and library; clock / automix / sampler / plugins are not in the app yet.
    static let native: [LayoutPanel] = [.deckA, .deckB, .mixer, .crossfader, .library]

    /// Native-only phone layout (decks side by side, mixer and library below); same JSON as the Kotlin
    /// `DemoPacks.phone`.
    static let phoneJson = #"{"v":1,"id":"phone","name":"Phone","columns":[1,1],"rows":[6,5,1,4],"areas":[{"panel":"deckA","col":0,"row":0},{"panel":"deckB","col":1,"row":0},{"panel":"mixer","col":0,"row":1,"colSpan":2},{"panel":"crossfader","col":0,"row":2,"colSpan":2},{"panel":"library","col":0,"row":3,"colSpan":2}],"gap":8}"#
}

private struct DockView<PanelContent: View>: View {
    let tabs: [LayoutPanel]
    let tier: LayoutTier
    let available: [LayoutPanel]
    let panel: (LayoutPanel, LayoutTier) -> PanelContent
    @State private var selected: LayoutPanel? = nil

    init(tabs: [LayoutPanel], tier: LayoutTier, available: [LayoutPanel], panel: @escaping (LayoutPanel, LayoutTier) -> PanelContent) {
        self.tabs = tabs
        self.tier = tier
        self.available = available
        self.panel = panel
    }

    var body: some View {
        let current = selected.flatMap { tabs.contains($0) ? $0 : nil } ?? tabs.first
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                ForEach(tabs, id: \.self) { t in
                    Button { selected = t } label: {
                        Text(PanelNames.name(t)).font(.caption.weight(.semibold)).lineLimit(1)
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .frame(minHeight: 44)
                            .background(Capsule().fill(t == current ? DecksTheme.accent : DecksTheme.raised))
                            .foregroundStyle(t == current ? DecksTheme.accentForeground : DecksTheme.foreground)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("layout.dock.show \(PanelNames.name(t))"))
                    .accessibilityAddTraits(t == current ? .isSelected : [])
                }
                Spacer(minLength: 0)
            }
            if let current {
                Group {
                    if available.contains(current) {
                        panel(current, tier)
                    } else {
                        Text("layout.unavailable \(PanelNames.name(current))")
                            .font(.caption).foregroundStyle(DecksTheme.muted)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(RoundedRectangle(cornerRadius: 14).fill(DecksTheme.surface))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

enum PanelNames {
    static func name(_ p: LayoutPanel) -> String {
        switch p {
        case .deckA: String(localized: "deck.a")
        case .deckB: String(localized: "deck.b")
        case .deckC: String(localized: "panel.deck \("C")")
        case .deckD: String(localized: "panel.deck \("D")")
        case .clock: String(localized: "panel.clock")
        case .mixer: String(localized: "panel.mixer")
        case .crossfader: String(localized: "panel.crossfader")
        case .library: String(localized: "panel.library")
        case .automix: String(localized: "panel.automix")
        case .sampler: String(localized: "panel.sampler")
        case .plugins: String(localized: "panel.plugins")
        }
    }

    /// Localised name of a layout (built-ins by id; pack layouts keep their own name).
    static func layout(_ l: DecksLayoutChoice) -> String {
        switch l.id {
        case "classic": String(localized: "layout.classic")
        case "performance": String(localized: "layout.performance")
        case "library": String(localized: "layout.library")
        case "four-deck": String(localized: "layout.four-deck")
        case "ultrawide": String(localized: "layout.ultrawide")
        case "stage": String(localized: "layout.stage")
        default: l.name
        }
    }
}
