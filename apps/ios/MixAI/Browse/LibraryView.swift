import MixaiCore
import SwiftUI

/// Library grid: `/media/library` grouped by (kind, tmdbId); cards come from home rows / title lookups.
struct LibraryView: View {
    @Environment(AppModel.self) private var app
    let ns: Namespace.ID
    @State private var kind: MediaKind = .movie
    @State private var cards: [TitleCard] = []
    @State private var unmatched = 0
    @State private var error: String?
    @State private var loaded = false

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 12)]

    var body: some View {
        ScrollView {
            Picker("library.kind", selection: $kind) {
                Text("library.movies").tag(MediaKind.movie)
                Text("library.series").tag(MediaKind.tv)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 20)
            let shown = cards.filter { $0.kind == kind }
            if !loaded {
                StateView(kind: .loading).frame(minHeight: 300)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else if shown.isEmpty {
                StateView(kind: .empty("library.empty", "library.empty_hint")).frame(minHeight: 300)
            } else {
                LazyVGrid(columns: columns, spacing: 16) {
                    ForEach(shown, id: \.self) { PosterCard(card: $0, width: 104, ns: ns) }
                }
                .padding(.horizontal, 20)
                if unmatched > 0 {
                    Text("library.unmatched \(unmatched)").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).padding()
                }
            }
        }
        .background(Theme.background)
        .navigationTitle("tab.library")
        .toolbar { ProfileToolbar() }
        .task(id: app.profileId) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let store = app.media else { return }
        error = nil
        do {
            let lib = try await store.library()
            var known: [String: TitleCard] = [:]
            if let h = await app.homeStore?.cached(profile: app.profileId) {
                for c in h.rows.flatMap(\.items) { known["\(c.kind.rawValue)-\(c.tmdbId)"] = c }
            }
            var keys: [(MediaKind, Int)] = []
            var seen = Set<String>()
            unmatched = 0
            for r in lib.items {
                guard let id = r.tmdbId else { unmatched += 1; continue }
                let k = "\(r.kind.rawValue)-\(id)"
                if seen.insert(k).inserted { keys.append((r.kind, id)) }
            }
            var out: [TitleCard] = []
            for (k, id) in keys {
                if let c = known["\(k.rawValue)-\(id)"] { out.append(c); continue }
                if let d = try? await store.title(kind: k, tmdbId: id) {
                    let t = d.title
                    out.append(TitleCard(kind: t.kind, tmdbId: t.tmdbId, title: t.title, posterPath: t.posterPath, backdropPath: t.backdropPath,
                                         releaseDate: t.releaseDate, voteAverage: t.voteAverage, genreIds: t.genreIds, inLibrary: true))
                }
                if out.count % 12 == 0 { cards = out.sorted { $0.title.localizedCompare($1.title) == .orderedAscending } }
            }
            cards = out.sorted { $0.title.localizedCompare($1.title) == .orderedAscending }
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}
