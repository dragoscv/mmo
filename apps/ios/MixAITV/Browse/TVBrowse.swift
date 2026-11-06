import MixaiCore
import SwiftUI

/// Library grid: `/media/library` grouped by (kind, tmdbId); cards from the cached home rows or title lookups.
struct TVLibraryView: View {
    @Environment(TVModel.self) private var model
    @State private var kind: MediaKind = .movie
    @State private var cards: [TitleCard] = []
    @State private var unmatched = 0
    @State private var error: String?
    @State private var loaded = false

    private let columns = [GridItem(.adaptive(minimum: 230), spacing: 48)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 30) {
                Picker("library.kind", selection: $kind) {
                    Text("library.movies").tag(MediaKind.movie)
                    Text("library.series").tag(MediaKind.tv)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 600)
                let shown = cards.filter { $0.kind == kind }
                if !loaded {
                    TVStateView(kind: .loading).frame(minHeight: 500)
                } else if let error {
                    TVStateView(kind: .error(error)) { Task { await load() } }
                } else if shown.isEmpty {
                    TVStateView(kind: .empty("library.empty", "library.empty_hint")).frame(minHeight: 500)
                } else {
                    LazyVGrid(columns: columns, spacing: 60) {
                        ForEach(shown, id: \.self) { TVPosterCard(card: $0, width: 230) }
                    }
                    if unmatched > 0 {
                        Text("library.unmatched \(unmatched)").font(TVTheme.body(22)).foregroundStyle(TVTheme.mutedForeground)
                    }
                }
            }
            .padding(80)
        }
        .background(TVTheme.background.ignoresSafeArea())
        .task(id: model.profileId) { await load() }
    }

    private func load() async {
        guard let store = model.media else { return }
        error = nil
        do {
            let lib = try await store.library()
            var known: [String: TitleCard] = [:]
            if let h = await model.homeStore?.cached(profile: model.profileId) {
                for c in h.rows.flatMap(\.items) { known["\(c.kind.rawValue)-\(c.tmdbId)"] = c }
            }
            var keys: [(MediaKind, Int)] = []
            var seen = Set<String>()
            unmatched = 0
            for r in lib.items {
                guard let id = r.tmdbId else { unmatched += 1; continue }
                if seen.insert("\(r.kind.rawValue)-\(id)").inserted { keys.append((r.kind, id)) }
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
            if tvIsCancellation(error) { return }
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

/// Title search through the server (TMDB), debounced; the system tvOS search keyboard via `.searchable`.
struct TVSearchView: View {
    @Environment(TVModel.self) private var model
    @State private var query = ""
    @State private var results: [TitleCard] = []
    @State private var loading = false

    var body: some View {
        ScrollView {
            if query.isEmpty {
                TVStateView(kind: .empty("search.prompt", "search.prompt_hint")).frame(minHeight: 500)
            } else if loading && results.isEmpty {
                ProgressView().frame(maxWidth: .infinity, minHeight: 400)
            } else if results.isEmpty {
                TVStateView(kind: .empty("search.none", "search.none_hint")).frame(minHeight: 500)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), spacing: 48)], spacing: 60) {
                    ForEach(tvUniqueCards(results), id: \.self) { TVPosterCard(card: $0, width: 230) }
                }
                .padding(80)
            }
        }
        .searchable(text: $query, prompt: Text("search.placeholder"))
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard q.count >= 2, let store = model.media else { results = []; return }
            try? await Task.sleep(for: .milliseconds(350))
            guard !Task.isCancelled else { return }
            loading = true
            defer { loading = false }
            if let page = try? await store.search(q) { results = page.results }
        }
    }
}

/// Live TV: first-use notice, channel grid with now playing, favourites first.
struct TVLiveView: View {
    @Environment(TVModel.self) private var model
    @AppStorage("liveNotice") private var accepted = false
    @State private var channels: [LiveTvChannel] = []
    @State private var now: [String: LiveTvNowNext] = [:]
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        Group {
            if !accepted {
                VStack(spacing: 30) {
                    Image(systemName: "dot.radiowaves.left.and.right").font(.system(size: 80)).foregroundStyle(TVTheme.primary)
                    Text("live.notice_title").font(TVTheme.heading(44)).multilineTextAlignment(.center)
                    Text("live.notice_body").font(TVTheme.body(28)).foregroundStyle(TVTheme.mutedForeground).multilineTextAlignment(.center).frame(maxWidth: 1200)
                    Button("live.notice_accept") { accepted = true }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !loaded {
                TVStateView(kind: .loading)
            } else if let error {
                TVStateView(kind: .error(error)) { Task { await load() } }
            } else if channels.isEmpty {
                TVStateView(kind: .empty("live.empty", "live.empty_hint"))
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 380), spacing: 40)], spacing: 40) {
                        ForEach(channels, id: \.id) { c in channelCard(c) }
                    }
                    .padding(80)
                }
            }
        }
        .background(TVTheme.background.ignoresSafeArea())
        .onAppear {
            #if DEBUG
            if ProcessInfo.processInfo.environment["MIXAI_LIVE_ACCEPTED"] == "1" { accepted = true }
            #endif
        }
        .task(id: accepted) { if accepted { await load() } }
    }

    private func channelCard(_ c: LiveTvChannel) -> some View {
        Button { model.playLive(c) } label: {
            HStack(spacing: 20) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14).fill(TVTheme.card)
                    if let logo = c.logo, let u = URL(string: logo) {
                        AsyncImage(url: u) { $0.resizable().scaledToFit() } placeholder: { Text(c.number ?? "").font(TVTheme.heading(30)) }.padding(10)
                    } else {
                        Text(c.number ?? String(c.name.prefix(2))).font(TVTheme.heading(30))
                    }
                }
                .frame(width: 110, height: 110)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        if c.favourite { Image(systemName: "star.fill").foregroundStyle(Tokens.Dark.warning) }
                        Text(c.name).font(TVTheme.body(28, weight: .semibold)).lineLimit(1)
                    }
                    if let p = now[c.id]?.now {
                        Text(p.title).font(TVTheme.body(22)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(16)
        }
        .buttonStyle(.card)
    }

    private func load() async {
        guard let live = model.liveTv else { return }
        error = nil
        do {
            let list = try await live.channels().filter { !$0.hidden }
            channels = list.sorted { ($0.favourite ? 0 : 1, $0.sort ?? Int.max, $0.name) < ($1.favourite ? 0 : 1, $1.sort ?? Int.max, $1.name) }
            if let nn = try? await live.nowNext() { now = Dictionary(nn.map { ($0.channelId, $0) }, uniquingKeysWith: { a, _ in a }) }
        } catch {
            if tvIsCancellation(error) { return }
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

/// Server, profile, version, disconnect.
struct TVSettingsView: View {
    @Environment(TVModel.self) private var model

    var body: some View {
        List {
            Section("settings.server") {
                LabeledContent("settings.server_name", value: model.server?.name ?? "—")
                LabeledContent("settings.server_url", value: model.server?.baseURL ?? "—")
                Button("settings.disconnect", role: .destructive) { model.disconnect() }
            }
            Section("settings.profiles") {
                LabeledContent("settings.active_profile", value: model.activeProfile?.name ?? "—")
                Button("settings.switch_profile") { Task { await model.switchProfile() } }
            }
            Section("settings.about") {
                LabeledContent("settings.version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                LabeledContent("settings.privacy", value: "mixai.ro/privacy")
            }
        }
        .frame(maxWidth: 1200)
        .navigationTitle("settings.title")
    }
}
