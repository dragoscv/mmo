import DecksFFI
import SwiftUI

/// Layout: waveforms on top (Rust renderer), then the zero-scroll [LayoutHost] (WP19-34: the chosen layout
/// preset or pack layout, solved by the Rust solver; panels that do not fit go to the dock). Compact width
/// (iPhone portrait) keeps the tabbed layout (decks / mixer / library).
struct RootView: View {
    @Environment(DecksStore.self) private var store
    @Environment(\.horizontalSizeClass) private var hSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tab = 0
    @State private var showSettings = false
    /// Skins / layouts / packs (shared with [AppearanceSettingsSection]).
    @State private var appearance = AppearanceStore.shared

    var body: some View {
        ZStack {
            DecksTheme.background.ignoresSafeArea()
            if hSize == .compact {
                compact
            } else {
                regular
            }
        }
        .foregroundStyle(DecksTheme.foreground)
        .tint(DecksTheme.accent)
        .onAppear { store.reduceMotion = reduceMotion }
        .onChange(of: reduceMotion) { _, v in store.reduceMotion = v }
        .overlay(alignment: .bottom) { errorBanner }
        #if os(iOS)
        .sheet(isPresented: $showSettings) { NavigationStack { SettingsView() } }
        #endif
    }

    private var waveforms: some View {
        WaveformView(store: store) { size in
            let w = Float(size.width), h = Float(size.height)
            let overview = max(14, h * 0.14)
            let lane = (h - overview * 2) / 2
            return [
                RenderView(kind: .waveform(deck: 0), x: 0, y: 0, w: w, h: lane),
                RenderView(kind: .waveform(deck: 1), x: 0, y: lane, w: w, h: lane),
                RenderView(kind: .overview(deck: 0), x: 0, y: lane * 2, w: w, h: overview),
                RenderView(kind: .overview(deck: 1), x: 0, y: lane * 2 + overview, w: w, h: overview),
            ]
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .topTrailing) { toolbar.padding(6) }
    }

    private var toolbar: some View {
        HStack(spacing: 6) {
            if let s = store.snapshot {
                Text(verbatim: String(format: "%.0f kHz · %.1f ms", Double(s.sampleRate) / 1000, s.latencyMs))
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(DecksTheme.muted)
                    .accessibilityLabel(Text("status.latency"))
            }
            Circle().fill(store.running ? DecksTheme.success : DecksTheme.danger).frame(width: 8, height: 8)
                .accessibilityLabel(Text(store.running ? LocalizedStringKey("status.engine_on") : LocalizedStringKey("status.engine_off")))
            #if os(iOS)
            Button { showSettings = true } label: { Image(systemName: "gearshape") }
                .accessibilityLabel(Text("settings.title"))
                .keyboardShortcut(",", modifiers: .command)
            #endif
        }
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Capsule().fill(DecksTheme.background.opacity(0.7)))
    }

    private var regular: some View {
        GeometryReader { geo in
            let layout = appearance.currentLayout
            let narrow = geo.size.width < 700
            let json = narrow ? LayoutHostDefaults.phoneJson : (layout?.json ?? LayoutHostDefaults.phoneJson)
            let hasLibrary = json.contains(#""panel":"library""#)
            let hasCrossfader = json.contains(#""panel":"crossfader""#)
            VStack(spacing: 10) {
                waveforms.frame(height: geo.size.height < 700 ? 110 : (hasLibrary ? 160 : 220))
                LayoutHost(layoutJson: json) { id, tier in
                    switch id {
                    case .deckA: DeckView(index: 0, tier: tier)
                    case .deckB: DeckView(index: 1, tier: tier)
                    case .mixer: MixerView(tier: tier, withCrossfader: !hasCrossfader)
                    case .crossfader: CrossfaderView(tier: tier)
                    case .library: LibraryView()
                    default: EmptyView()
                    }
                }
            }
            .padding(10)
        }
    }

    private var compact: some View {
        VStack(spacing: 8) {
            waveforms.frame(height: 150)
            Picker("tab.title", selection: $tab) {
                Text("tab.decks").tag(0)
                Text("tab.mixer").tag(1)
                Text("tab.library").tag(2)
            }
            .pickerStyle(.segmented)
            switch tab {
            case 0:
                ScrollView {
                    VStack(spacing: 10) {
                        ScrollView(.horizontal) { DeckView(index: 0) }
                        ScrollView(.horizontal) { DeckView(index: 1) }
                    }
                }
            case 1:
                ScrollView { MixerView() }
            default:
                LibraryView()
            }
        }
        .padding(8)
    }

    @ViewBuilder private var errorBanner: some View {
        if let e = store.lastError {
            HStack {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(DecksTheme.warning).accessibilityHidden(true)
                Text(verbatim: e).font(.caption).lineLimit(2)
                Spacer()
                Button { store.lastError = nil } label: { Image(systemName: "xmark") }
                    .accessibilityLabel(Text("common.dismiss"))
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 10).fill(DecksTheme.raised))
            .padding()
        }
    }
}
