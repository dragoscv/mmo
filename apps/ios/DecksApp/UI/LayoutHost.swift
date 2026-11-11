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
    /// Docked panels the screen already shows somewhere else: they get no dock tab. RootView always draws the
    /// waveforms of both decks above the layout, which is what the Decks 1.5 `waves` panel is.
    var shownElsewhere: [LayoutPanel] = [.waves]
    @ViewBuilder let panel: (LayoutPanel, LayoutTier) -> PanelContent

    var body: some View {
        GeometryReader { geo in
            let sol = solve(geo.size)
            let docked = sol.docked.filter { !shownElsewhere.contains($0) }
            // Nothing left to dock: no dock, and the panel that would have hosted it keeps its own slot.
            let dock: LayoutRect? = docked.isEmpty ? nil : sol.dock
            let hostIndex = dock.flatMap { d in sol.placements.firstIndex { Self.same($0.rect, d) } }
            let host = hostIndex.map { sol.placements[$0] }
            ZStack(alignment: .topLeading) {
                ForEach(Array(sol.placements.indices), id: \.self) { i in
                    if i != hostIndex {
                        let p = sol.placements[i]
                        panel(p.panel, ContentTiers.tier(p.panel, solver: p.tier, width: p.rect.w, height: p.rect.h))
                            .frame(width: CGFloat(p.rect.w), height: CGFloat(p.rect.h))
                            // Zero-scroll: a panel never draws over its neighbours.
                            .clipped()
                            .offset(x: CGFloat(p.rect.x), y: CGFloat(p.rect.y))
                    }
                }
                if let dock {
                    DockView(tabs: (host.map { [$0.panel] } ?? []) + docked, tier: host?.tier ?? .icon,
                             width: dock.w, height: dock.h, available: available, panel: panel)
                        .frame(width: CGFloat(dock.w), height: CGFloat(dock.h))
                        .clipped()
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

/// The tier a panel RENDERS at. The Decks 1.5 contract (`PANEL_SPECS`, shared with the desktop app and the Rust
/// solver) calls a 480×250 deck `full` because the desktop app redesigned its panels as wide, short strips. The
/// SwiftUI deck and mixer still have their Decks 1.4 content (150 pt jog wheel, button rows, stacked knobs), built
/// for the 1.4 minimums below, and SwiftUI does not shrink them: so a panel renders the richest tier whose content
/// fits the rect the solver gave, never richer than the solver's tier. Mirror of `contentTier` in the Compose
/// LayoutHost.kt; remove once DeckView / MixerView are redesigned.
enum ContentTiers {
    /// Same tolerance as the solver (`FIT_TOLERANCE`).
    private static let tolerance = 0.5

    private struct Step {
        let tier: LayoutTier
        let w: Double
        let h: Double
    }

    /// Minimum size (pt) of the content per tier, richest first: the Decks 1.4 `PANEL_SPECS` the views were built
    /// for. Empty = the panel has no content minimum (the solver's tier is used as is).
    private static func minimums(_ panel: LayoutPanel) -> [Step] {
        switch panel {
        case .deckA, .deckB, .deckC, .deckD:
            return [Step(tier: .full, w: 460, h: 560), Step(tier: .compact, w: 340, h: 330)]
        case .mixer:
            return [Step(tier: .full, w: 240, h: 440), Step(tier: .compact, w: 200, h: 260)]
        // The crossfader sizes itself to its slot; library and the rest have no tiers.
        default:
            return []
        }
    }

    private static func rank(_ t: LayoutTier) -> Int {
        switch t {
        case .full: return 0
        case .compact: return 1
        case .icon: return 2
        }
    }

    static func tier(_ panel: LayoutPanel, solver: LayoutTier, width: Double, height: Double) -> LayoutTier {
        let table = minimums(panel)
        if table.isEmpty { return solver }
        var fit = LayoutTier.icon
        for step in table where width + tolerance >= step.w && height + tolerance >= step.h {
            fit = step.tier
            break
        }
        return rank(fit) >= rank(solver) ? fit : solver
    }
}

enum LayoutHostDefaults {
    /// Two decks, mixer, crossfader and library; clock / automix / sampler / plugins are not in the app yet, and the
    /// waveforms (`waves`) are drawn by RootView above the layout, not as a layout panel.
    static let native: [LayoutPanel] = [.deckA, .deckB, .mixer, .crossfader, .library]

    /// Layout shown to a user who never picked one. The contract default (`layoutDefaultId()`) is `pro` since
    /// Decks 1.5, but `pro` sizes its boxes for the redesigned desktop panels; until DeckView / MixerView are
    /// redesigned this app stays on the layout their content fits (same decision as the Compose apps,
    /// `DecksSkin.DEFAULT_LAYOUT`). Pro and Vertical waves stay selectable.
    static let fallbackLayoutId = "classic"

    /// Height (pt) the dock's tab strip takes from the dock slot (44 pt tabs + 4 pt spacing).
    static let dockTabsHeight = 48.0

    /// Native-only phone layout (decks side by side, mixer and library below); same JSON as the Kotlin
    /// `DemoPacks.phone`.
    static let phoneJson = #"{"v":1,"id":"phone","name":"Phone","columns":[1,1],"rows":[6,5,1,4],"areas":[{"panel":"deckA","col":0,"row":0},{"panel":"deckB","col":1,"row":0},{"panel":"mixer","col":0,"row":1,"colSpan":2},{"panel":"crossfader","col":0,"row":2,"colSpan":2},{"panel":"library","col":0,"row":3,"colSpan":2}],"gap":8}"#
}

private struct DockView<PanelContent: View>: View {
    let tabs: [LayoutPanel]
    let tier: LayoutTier
    /// Size (pt) of the dock slot.
    let width: Double
    let height: Double
    let available: [LayoutPanel]
    let panel: (LayoutPanel, LayoutTier) -> PanelContent
    @State private var selected: LayoutPanel? = nil

    init(tabs: [LayoutPanel], tier: LayoutTier, width: Double, height: Double, available: [LayoutPanel],
         panel: @escaping (LayoutPanel, LayoutTier) -> PanelContent) {
        self.tabs = tabs
        self.tier = tier
        self.width = width
        self.height = height
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
                        panel(current, ContentTiers.tier(current, solver: tier, width: width,
                                                         height: max(0, height - LayoutHostDefaults.dockTabsHeight)))
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
        // Decks 1.5 panel. It is not a layout panel here (RootView draws the waveforms above the layout), so the
        // solver docks it and `LayoutHost.shownElsewhere` drops its tab; the name is only needed if a caller keeps
        // the tab. Reuses an existing string (no new catalogue key).
        case .waves: String(localized: "waveform.a11y")
        }
    }

    /// Localised name of a layout (built-ins by id; pack layouts keep their own name).
    static func layout(_ l: DecksLayoutChoice) -> String {
        switch l.id {
        // "pro" / "pro-vertical" (Decks 1.5) keep the name from the preset JSON until they get catalogue keys.
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
