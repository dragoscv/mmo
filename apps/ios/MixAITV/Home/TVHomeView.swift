import MixaiCore
import SwiftUI

/// Home: full-bleed hero (backdrop follows the focused card) + server rows. First paint from the SWR disk cache.
struct TVHomeView: View {
    @Environment(TVModel.self) private var model
    @State private var home: MediaHome?
    @State private var error: String?
    @State private var focused: TitleCard?

    var body: some View {
        Group {
            if let home { content(home) } else if let error {
                TVStateView(kind: .error(error)) { Task { await load() } }
            } else {
                TVStateView(kind: .loading)
            }
        }
        .background(TVTheme.background.ignoresSafeArea())
        .task(id: model.profileId) { await load() }
    }

    private func load() async {
        guard let store = model.homeStore else { return }
        error = nil
        do {
            for try await u in await store.updates(profile: model.profileId) {
                switch u {
                case .cached(let h): home = h
                case .fresh(let h, let changed): if changed || home == nil { home = h }
                }
            }
        } catch {
            if home == nil, !tvIsCancellation(error) { self.error = error.localizedDescription }
        }
    }

    /// Own library first: the first in-library card with art.
    private func heroCard(_ h: MediaHome) -> TitleCard? {
        let all = h.rows.flatMap(\.items)
        return all.first { $0.inLibrary == true && $0.backdropPath != nil } ?? all.first { $0.backdropPath != nil }
    }

    private func content(_ h: MediaHome) -> some View {
        let hero = focused ?? heroCard(h)
        return ZStack(alignment: .topLeading) {
            if let hero {
                TVRemoteImage(url: model.client?.tmdbImageURL(size: TmdbSize.backdrop(1280), path: hero.backdropPath), aspect: 16 / 9)
                    .frame(maxWidth: .infinity)
                    .overlay(TVTheme.heroScrimLeading)
                    .overlay(TVTheme.heroScrimBottom)
                    .ignoresSafeArea()
                    .animation(.easeInOut(duration: 0.4), value: hero.tmdbId)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 48) {
                    if let hero { TVHeroText(card: hero).padding(.top, 40).frame(height: 520, alignment: .bottomLeading) }
                    if !h.configured {
                        Text("home.not_configured").font(TVTheme.body(26)).foregroundStyle(TVTheme.mutedForeground)
                    }
                    ForEach(h.rows.filter { !$0.items.isEmpty }, id: \.id) { row in
                        VStack(alignment: .leading, spacing: 20) {
                            Text(row.localizedTitle(model.lang)).font(TVTheme.heading(36)).accessibilityAddTraits(.isHeader)
                            ScrollView(.horizontal) {
                                LazyHStack(spacing: 40) {
                                    ForEach(tvUniqueCards(row.items), id: \.self) { c in
                                        TVPosterCard(card: c, onFocus: { focused = c })
                                    }
                                }
                                .padding(.vertical, 30)
                            }
                            .scrollClipDisabled()
                        }
                    }
                    if h.rows.allSatisfy(\.items.isEmpty) {
                        TVStateView(kind: .empty("home.empty", "home.empty_hint")).frame(minHeight: 400)
                    }
                }
                .padding(.horizontal, 80)
                .padding(.bottom, 60)
            }
        }
    }
}

struct TVHeroText: View {
    let card: TitleCard

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(card.title).font(TVTheme.heading(76)).lineLimit(2).shadow(radius: 12)
            HStack(spacing: 14) {
                if let y = PlayResolver.year(card.releaseDate) { chip(y) }
                if let a = card.age { chip("\(a)+") }
                if let v = card.voteAverage, v > 0 { chip(String(format: "★ %.1f", v)) }
                if card.inLibrary == true { chip(String(localized: "home.in_library")) }
            }
            if let o = card.overview, !o.isEmpty {
                Text(o).font(TVTheme.body(28)).foregroundStyle(.white.opacity(0.85)).lineLimit(3).frame(maxWidth: 1000, alignment: .leading)
            }
        }
    }

    private func chip(_ s: String) -> some View {
        Text(s).font(TVTheme.body(22, weight: .semibold)).padding(.horizontal, 16).padding(.vertical, 8)
            .background(.ultraThinMaterial, in: .rect(cornerRadius: 12))
    }
}
