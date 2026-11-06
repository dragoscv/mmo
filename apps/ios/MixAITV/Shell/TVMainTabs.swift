import MixaiCore
import SwiftUI

enum TVRoute: Hashable {
    case title(kind: MediaKind, tmdbId: Int)
}

/// Top tab bar (tvOS standard): Home, Library, Live TV, Search, Settings. Each tab owns a NavigationStack.
struct TVMainTabs: View {
    @Environment(TVModel.self) private var model
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            Tab("tab.home", systemImage: "house", value: 0) { TVStack(consumesDeepLinks: true) { TVHomeView() } }
            Tab("tab.library", systemImage: "square.grid.2x2", value: 1) { TVStack { TVLibraryView() } }
            Tab("tab.live", systemImage: "dot.radiowaves.left.and.right", value: 2) { TVStack { TVLiveView() } }
            Tab("tab.search", systemImage: "magnifyingglass", value: 3, role: .search) { TVStack { TVSearchView() } }
            Tab("settings.title", systemImage: "gearshape", value: 4) { TVStack { TVSettingsView() } }
        }
        .onChange(of: model.pendingRoute) { _, r in if r != nil { tab = 0 } }
        .task {
            #if DEBUG
            // Simulator screenshots: SIMCTL_CHILD_MIXAI_TAB=<0-4>, SIMCTL_CHILD_MIXAI_OPEN=title/<kind>/<id>.
            let env = ProcessInfo.processInfo.environment
            if let t = env["MIXAI_TAB"].flatMap(Int.init) { tab = t }
            if let open = env["MIXAI_OPEN"] {
                let p = open.split(separator: "/").map(String.init)
                if p.count == 3, p[0] == "title", let k = MediaKind(rawValue: p[1]), let id = Int(p[2]) { model.pendingRoute = .title(kind: k, tmdbId: id) }
            }
            #endif
        }
    }
}

private struct TVStack<Content: View>: View {
    @Environment(TVModel.self) private var model
    var consumesDeepLinks = false
    @ViewBuilder var content: Content
    @State private var path: [TVRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: TVRoute.self) { r in
                    switch r {
                    case .title(let k, let id): TVTitleView(kind: k, tmdbId: id)
                    }
                }
        }
        .onChange(of: model.pendingRoute, initial: true) { _, r in
            guard consumesDeepLinks, let r else { return }
            path = [r]
            model.pendingRoute = nil
        }
    }
}

/// AsyncImage with a token-coloured placeholder and fixed aspect.
struct TVRemoteImage: View {
    let url: URL?
    var aspect: CGFloat = 2.0 / 3.0

    var body: some View {
        Color.clear
            .aspectRatio(aspect, contentMode: .fit)
            .overlay {
                AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.25))) { phase in
                    switch phase {
                    case .success(let img): img.resizable().aspectRatio(contentMode: .fill)
                    default: Rectangle().fill(TVTheme.card).overlay(Image(systemName: "film").font(.system(size: 40)).foregroundStyle(TVTheme.mutedForeground.opacity(0.5)))
                    }
                }
            }
            .clipped()
            .accessibilityHidden(true)
    }
}

/// Focusable poster: tvOS card button style gives the lift + parallax; progress bar for continue rows.
struct TVPosterCard: View {
    @Environment(TVModel.self) private var model
    let card: TitleCard
    var width: CGFloat = 250
    /// Called when this card gains focus (Home hero follows the focused card).
    var onFocus: (() -> Void)?

    var body: some View {
        NavigationLink(value: TVRoute.title(kind: card.kind, tmdbId: card.tmdbId)) {
            TVRemoteImage(url: model.client?.tmdbImageURL(size: TmdbSize.poster(Int(width * 2)), path: card.posterPath))
                .frame(width: width)
                .background { if let onFocus { TVFocusProbe(onFocus: onFocus) } }
                .overlay(alignment: .bottom) {
                    if let p = card.progress, p > 0 {
                        GeometryReader { g in Capsule().fill(TVTheme.primary).frame(width: g.size.width * min(1, p), height: 6) }
                            .frame(height: 6).padding(10)
                    }
                }
        }
        .buttonStyle(.card)
        .accessibilityLabel(Text(card.title))
    }
}

/// Reports focus of the enclosing focusable (button label content sees `isFocused`).
struct TVFocusProbe: View {
    @Environment(\.isFocused) private var focused
    let onFocus: () -> Void
    var body: some View {
        Color.clear.onChange(of: focused) { _, now in if now { onFocus() } }
    }
}

/// A restarted `.task(id:)` cancels the previous request; that is not an error worth showing.
func tvIsCancellation(_ e: Error) -> Bool {
    e is CancellationError || (e as? URLError)?.code == .cancelled
}

/// Server rows can repeat a title (two files of one film) → keep the first occurrence.
func tvUniqueCards(_ items: [TitleCard]) -> [TitleCard] {
    var seen = Set<String>()
    return items.filter { seen.insert("\($0.kind.rawValue)-\($0.tmdbId)").inserted }
}

/// Loading / empty / error states shared by every screen.
struct TVStateView: View {
    enum Kind { case loading, empty(LocalizedStringKey, LocalizedStringKey), error(String) }
    let kind: Kind
    var retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 24) {
            switch kind {
            case .loading:
                ProgressView()
            case .empty(let t, let hint):
                Image(systemName: "sparkles.tv").font(.system(size: 80)).foregroundStyle(TVTheme.mutedForeground)
                Text(t).font(TVTheme.heading(40))
                Text(hint).font(TVTheme.body(28)).foregroundStyle(TVTheme.mutedForeground).multilineTextAlignment(.center)
            case .error(let msg):
                Image(systemName: "wifi.exclamationmark").font(.system(size: 80)).foregroundStyle(TVTheme.destructive)
                Text("state.error").font(TVTheme.heading(40))
                Text(msg).font(TVTheme.body(26)).foregroundStyle(TVTheme.mutedForeground).multilineTextAlignment(.center)
            }
            if let retry, case .error = kind { Button("action.retry", action: retry) }
        }
        .padding(60)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
