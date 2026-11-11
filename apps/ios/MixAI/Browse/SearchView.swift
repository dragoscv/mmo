import MixaiCore
import SwiftUI

/// Search across titles (TMDB via the server), music and Live TV channels; debounced.
struct SearchView: View {
    @Environment(AppModel.self) private var app
    let ns: Namespace.ID
    @State private var query = ""
    @State private var titles: [TitleCard] = []
    @State private var music: MusicSearch?
    @State private var channels: [LiveTvChannel] = []
    @State private var loading = false

    var body: some View {
        List {
            if query.isEmpty {
                StateView(kind: .empty("search.prompt", "search.prompt_hint")).listRowBackground(Color.clear)
            } else if loading && titles.isEmpty {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if titles.isEmpty && (music?.tracks.isEmpty ?? true) && (music?.albums.isEmpty ?? true) && channels.isEmpty {
                StateView(kind: .empty("search.none", "search.none_hint")).listRowBackground(Color.clear)
            }
            if !titles.isEmpty {
                Section("search.titles") {
                    ScrollView(.horizontal) {
                        LazyHStack(spacing: 12) { ForEach(uniqueCards(titles), id: \.self) { PosterCard(card: $0, width: 110, ns: ns) } }
                    }
                    .scrollIndicators(.hidden)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
            if let m = music, !m.albums.isEmpty {
                Section("search.albums") {
                    ForEach(m.albums.prefix(8), id: \.id) { a in
                        NavigationLink(value: Route.album(a.id)) {
                            HStack {
                                RemoteImage(url: app.musicStore?.coverURL(a.coverUrlPath), aspect: 1).frame(width: 44).clipShape(.rect(cornerRadius: 6))
                                VStack(alignment: .leading) { Text(a.name); Text(a.artist ?? "").font(.caption).foregroundStyle(Theme.mutedForeground) }
                            }
                        }
                    }
                }
            }
            if let m = music, !m.tracks.isEmpty {
                Section("search.tracks") {
                    ForEach(Array(m.tracks.prefix(10).enumerated()), id: \.element.id) { i, t in
                        Button {
                            if let s = app.musicStore { app.music.play(Array(m.tracks.prefix(10)), at: i, store: s, video: app.player) }
                        } label: {
                            VStack(alignment: .leading) { Text(t.title); Text(t.artist ?? "").font(.caption).foregroundStyle(Theme.mutedForeground) }
                        }
                    }
                }
            }
            if !channels.isEmpty {
                Section("search.channels") {
                    ForEach(channels.prefix(10), id: \.id) { c in
                        Button { app.player.start(PlayRequest(source: .live(channelId: c.id, name: c.name), title: c.name, subtitle: nil, artwork: nil), app: app) } label: {
                            Label(c.name, systemImage: "dot.radiowaves.left.and.right")
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("tab.search")
        .searchable(text: $query, prompt: Text("search.placeholder"))
        .toolbar { ProfileToolbar() }
        .task(id: query) { await search() }
        .task {
            #if DEBUG
            // Simulator checks: SIMCTL_CHILD_MIXAI_SEARCH=<text> fills the query (simctl cannot type).
            if query.isEmpty, let q = ProcessInfo.processInfo.environment["MIXAI_SEARCH"], !q.isEmpty { query = q }
            #endif
        }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { titles = []; music = nil; channels = []; return }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        loading = true
        defer { loading = false }
        async let t = try? app.media?.search(q).results
        async let m = try? app.musicStore?.search(q)
        async let c = try? app.liveTv?.channels()
        titles = await t ?? []
        music = await m ?? nil
        let lower = q.lowercased()
        channels = (await c ?? []).filter { $0.name.lowercased().contains(lower) }
    }
}
