import MixaiCore
import SwiftUI

/// Home: cinematic hero (backdrop, title, chips, Play/Resume + My list) and server rows.
/// First paint from the SWR disk cache, then revalidated via /media/etag.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    let ns: Namespace.ID
    @State private var home: MediaHome?
    @State private var error: String?
    @State private var firstPaintMs: Int?

    var body: some View {
        Group {
            if let home {
                content(home)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else {
                StateView(kind: .loading)
            }
        }
        .background(Theme.background)
        .toolbar { ProfileToolbar() }
        .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        .task(id: app.profileId) { await load() }
        .refreshable { await refresh() }
    }

    private func load() async {
        guard let store = app.homeStore else { return }
        let started = ContinuousClock.now
        error = nil
        do {
            for try await u in await store.updates(profile: app.profileId) {
                switch u {
                case .cached(let h): home = h
                case .fresh(let h, let changed): if changed || home == nil { home = h }
                }
                if firstPaintMs == nil {
                    let d = ContinuousClock.now - started
                    firstPaintMs = Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000)
                    print("MixaiPerf home first paint \(firstPaintMs ?? -1) ms")
                }
            }
        } catch {
            if home == nil { self.error = error.localizedDescription }
        }
    }

    private func refresh() async {
        guard let store = app.homeStore else { return }
        if let h = try? await store.fetch(profile: app.profileId) { home = h }
    }

    /// Own library first (D25): the hero is the first in-library card of the first non-empty row.
    private func heroCard(_ h: MediaHome) -> TitleCard? {
        let all = h.rows.flatMap(\.items)
        return all.first { $0.inLibrary == true && $0.backdropPath != nil } ?? all.first { $0.backdropPath != nil }
    }

    private func content(_ h: MediaHome) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 26) {
                if let hero = heroCard(h) { HeroView(card: hero, ns: ns) }
                if !h.configured {
                    Text("home.not_configured").font(Theme.body(14)).foregroundStyle(Theme.mutedForeground).padding(.horizontal, 20)
                }
                ForEach(h.rows.filter { !$0.items.isEmpty }, id: \.id) { row in
                    VStack(alignment: .leading, spacing: 10) {
                        SectionHeader(title: row.localizedTitle(app.lang))
                        ScrollView(.horizontal) {
                            LazyHStack(spacing: 12) {
                                ForEach(uniqueCards(row.items), id: \.self) { c in PosterCard(card: c, ns: ns) }
                            }
                            .padding(.horizontal, 20)
                        }
                        .scrollIndicators(.hidden)
                    }
                }
                if h.rows.allSatisfy(\.items.isEmpty) {
                    StateView(kind: .empty("home.empty", "home.empty_hint")).frame(minHeight: 300)
                }
                Color.clear.frame(height: 40)
            }
        }
        .ignoresSafeArea(edges: .top)
    }
}

/// Server rows can repeat a title (two files of one film) → keep the first occurrence.
func uniqueCards(_ items: [TitleCard]) -> [TitleCard] {
    var seen = Set<String>()
    return items.filter { seen.insert("\($0.kind.rawValue)-\($0.tmdbId)").inserted }
}

struct HeroView: View {
    @Environment(AppModel.self) private var app
    let card: TitleCard
    let ns: Namespace.ID
    @State private var busy = false

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            RemoteImage(url: app.client?.tmdbImageURL(size: TmdbSize.backdrop(1280), path: card.backdropPath), aspect: 4 / 5)
                .overlay(Theme.heroScrim)
            VStack(alignment: .leading, spacing: 12) {
                Text(card.title).font(Theme.heading(34)).lineLimit(2).shadow(radius: 8)
                HStack(spacing: 8) {
                    if let y = PlayResolver.year(card.releaseDate) { chip(y) }
                    if let a = card.age { chip("\(a)+") }
                    if let v = card.voteAverage, v > 0 { chip(String(format: "★ %.1f", v)) }
                    if card.inLibrary == true { chip(String(localized: "home.in_library")) }
                }
                if let o = card.overview, !o.isEmpty {
                    Text(o).font(Theme.body(14)).foregroundStyle(.white.opacity(0.85)).lineLimit(3)
                }
                HStack(spacing: 12) {
                    Button { play() } label: {
                        Label((card.progress ?? 0) > 0 ? "action.resume" : "action.play", systemImage: "play.fill").padding(.horizontal, 10).padding(.vertical, 4)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(busy || card.inLibrary != true)
                    NavigationLink(value: Route.title(kind: card.kind, tmdbId: card.tmdbId, posterPath: card.posterPath)) {
                        Label("action.details", systemImage: "info.circle").padding(.horizontal, 6).padding(.vertical, 4)
                    }
                    .buttonStyle(.glass)
                }
                .controlSize(.large)
            }
            .padding(20)
        }
    }

    private func chip(_ s: String) -> some View {
        Text(s).font(Theme.body(12, weight: .semibold)).padding(.horizontal, 10).padding(.vertical, 5).glassCard(cornerRadius: 10)
    }

    private func play() {
        guard let store = app.media else { return }
        busy = true
        Task {
            defer { busy = false }
            guard let d = try? await store.title(kind: card.kind, tmdbId: card.tmdbId),
                  let t = await PlayResolver.resolve(d, store: store) else { return }
            app.player.start(PlayRequest(source: .file(fileId: t.fileId, ref: t.ref, startSec: t.resumeSec ?? 0), title: d.title.title,
                                         subtitle: t.ref.season.map { s in "S\(s) E\(t.ref.episode ?? 0)" }, artwork: nil), app: app)
        }
    }
}
