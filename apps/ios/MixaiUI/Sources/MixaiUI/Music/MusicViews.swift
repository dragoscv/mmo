import MixaiCore
import SwiftUI

// Shared music screens of MixAI and MixAI Music (D51). Data comes from `MusicEnvironment`; navigation uses
// `MusicRoute` (hosts add `.musicDestinations()`). Every screen has loading / empty / error / loaded states.

/// Music home: Start a mix, recent / newest / most played / playlists / random albums.
public struct MusicHomeView: View {
    @Environment(MusicEnvironment.self) private var env
    @State private var home: MusicHome?
    @State private var error: String?
    @State private var mixing = false
    let reloadKey: String

    public init(reloadKey: String = "") { self.reloadKey = reloadKey }

    public var body: some View {
        ScrollView {
            if let h = home {
                VStack(alignment: .leading, spacing: 24) {
                    mixCard
                    if h.recent.isEmpty && h.newest.isEmpty && h.mostPlayed.isEmpty {
                        StateView(kind: .empty("music.empty", "music.empty_hint"), symbol: "music.note.list").frame(minHeight: 280)
                    }
                    AlbumRow(title: String(localized: "music.recent"), albums: h.recent)
                    AlbumRow(title: String(localized: "music.newest"), albums: h.newest)
                    if !h.mostPlayed.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeader(title: String(localized: "music.most_played"))
                            ForEach(Array(h.mostPlayed.prefix(10).enumerated()), id: \.element.id) { i, t in
                                TrackRow(track: t, list: h.mostPlayed) { env.play(h.mostPlayed, at: i) }
                            }
                        }
                    }
                    if !h.playlists.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeader(title: String(localized: "music.playlists"))
                            ScrollView(.horizontal) {
                                LazyHStack(spacing: 12) {
                                    ForEach(h.playlists, id: \.id) { p in
                                        NavigationLink(value: MusicRoute.playlist(id: p.id, name: p.name)) {
                                            CoverTile(url: env.cover(p.coverUrlPath), title: p.name, subtitle: String(localized: "music.tracks_count \(p.songCount)"), symbol: "music.note.list")
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                .padding(.horizontal, 20)
                            }
                            .scrollIndicators(.hidden)
                        }
                    }
                    AlbumRow(title: String(localized: "music.random"), albums: h.randomAlbums)
                    browseLinks
                }
                .padding(.vertical, 12)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else {
                StateView(kind: .loading).frame(minHeight: 360)
            }
        }
        .background(Theme.background)
        .refreshable { await load() }
        .task(id: reloadKey) { await load() }
    }

    private var mixCard: some View {
        Button {
            guard let s = env.store, !mixing else { return }
            mixing = true
            Task { await env.player.startMix(store: s); mixing = false }
        } label: {
            HStack(spacing: 14) {
                Image(systemName: "sparkles").font(.title2).frame(width: 48, height: 48).background(Theme.brandGradient, in: .circle).foregroundStyle(.white)
                VStack(alignment: .leading, spacing: 2) {
                    Text("music.start_mix").font(Theme.heading(18))
                    Text("music.start_mix_hint").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                }
                Spacer()
                if mixing { ProgressView() } else { Image(systemName: "play.fill").foregroundStyle(Theme.primary) }
            }
            .padding(14)
            .glassCard(cornerRadius: 20)
            .padding(.horizontal, 20)
        }
        .buttonStyle(.plain)
        .accessibilityHint(Text("music.start_mix_hint"))
    }

    private var browseLinks: some View {
        VStack(spacing: 0) {
            NavigationLink(value: MusicRoute.artists) { BrowseRow(title: "music.artists", symbol: "music.mic") }
            NavigationLink(value: MusicRoute.albums) { BrowseRow(title: "music.albums", symbol: "square.stack") }
            NavigationLink(value: MusicRoute.playlists) { BrowseRow(title: "music.playlists", symbol: "music.note.list") }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 20)
    }

    private func load() async {
        guard let s = env.store else { return }
        do { home = try await s.home(); error = nil } catch { if home == nil { self.error = error.localizedDescription } }
    }
}

struct BrowseRow: View {
    let title: LocalizedStringKey
    let symbol: String
    var body: some View {
        HStack {
            Image(systemName: symbol).frame(width: 28).foregroundStyle(Theme.primary)
            Text(title).font(Theme.body(16, weight: .medium))
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(Theme.mutedForeground)
        }
        .padding(.vertical, 12)
        .contentShape(.rect)
    }
}

struct CoverTile: View {
    let url: URL?
    let title: String
    let subtitle: String
    var symbol = "music.note"
    var round = false
    var body: some View {
        VStack(alignment: round ? .center : .leading, spacing: 4) {
            RemoteImage(url: url, aspect: 1, placeholderSymbol: symbol)
                .frame(width: 140)
                .clipShape(RoundedRectangle(cornerRadius: round ? 70 : 12))
            Text(title).font(Theme.body(13, weight: .medium)).lineLimit(1)
            Text(subtitle).font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
        }
        .frame(width: 140)
        .accessibilityElement(children: .combine)
    }
}

/// Horizontal row of album covers.
public struct AlbumRow: View {
    @Environment(MusicEnvironment.self) private var env
    let title: String
    let albums: [AlbumCard]

    public init(title: String, albums: [AlbumCard]) {
        self.title = title
        self.albums = albums
    }

    public var body: some View {
        if !albums.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: title)
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 12) {
                        ForEach(uniqueAlbums(albums), id: \.id) { a in
                            NavigationLink(value: MusicRoute.album(a.id)) {
                                CoverTile(url: env.cover(a.coverUrlPath), title: a.name, subtitle: a.artist ?? "")
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
        }
    }
}

/// Server rows can repeat an album; SwiftUI ids must be unique.
func uniqueAlbums(_ a: [AlbumCard]) -> [AlbumCard] {
    var seen = Set<String>()
    return a.filter { seen.insert($0.id).inserted }
}

/// One track: tap plays; context menu = play next / add to queue / start radio / download / go to album / artist.
public struct TrackRow: View {
    @Environment(MusicEnvironment.self) private var env
    let track: TrackCard
    var list: [TrackCard]
    var showNumber: Bool
    let action: () -> Void

    public init(track: TrackCard, list: [TrackCard] = [], showNumber: Bool = false, action: @escaping () -> Void) {
        self.track = track
        self.list = list
        self.showNumber = showNumber
        self.action = action
    }

    public var body: some View {
        let isCurrent = env.player.current?.id == track.id
        Button(action: action) {
            HStack(spacing: 12) {
                if showNumber {
                    Text(track.track.map(String.init) ?? "").font(Theme.body(13)).monospacedDigit().foregroundStyle(Theme.mutedForeground).frame(width: 24, alignment: .trailing)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title).font(Theme.body(15, weight: .medium)).lineLimit(1).foregroundStyle(isCurrent ? Theme.primary : Theme.foreground)
                    Text(track.artist ?? "").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                }
                Spacer()
                if let dl = env.downloads?.state(track.id) { DownloadBadge(state: dl) }
                if track.hasSyncedLyrics { Image(systemName: "quote.bubble").foregroundStyle(Theme.mutedForeground).accessibilityLabel(Text("music.has_lyrics")) }
                Text(formatClock(track.durationSec)).font(Theme.body(12)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
            }
            .padding(.horizontal, 20).padding(.vertical, 7)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .contextMenu { TrackMenu(track: track) }
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}

/// Track actions (context menu / swipe).
struct TrackMenu: View {
    @Environment(MusicEnvironment.self) private var env
    let track: TrackCard
    var body: some View {
        Button { env.player.playNext([track]) } label: { Label("music.play_next", systemImage: "text.line.first.and.arrowtriangle.forward") }
        Button { env.player.addToQueue([track]) } label: { Label("music.add_to_queue", systemImage: "text.append") }
        Button {
            if let s = env.store { Task { await env.player.startMix(seed: track.id, store: s) } }
        } label: { Label("music.start_radio", systemImage: "dot.radiowaves.left.and.right") }
        if let dl = env.downloads {
            if dl.state(track.id) == .done {
                Button(role: .destructive) { dl.remove([track.id]) } label: { Label("music.dl.remove", systemImage: "trash") }
            } else {
                Button { dl.download([track]) } label: { Label("downloads.download", systemImage: "arrow.down.circle") }
            }
        }
        if !track.albumId.isEmpty {
            NavigationLink(value: MusicRoute.album(track.albumId)) { Label("music.go_album", systemImage: "square.stack") }
        }
        if let a = track.artistId {
            NavigationLink(value: MusicRoute.artist(a)) { Label("music.go_artist", systemImage: "music.mic") }
        }
    }
}

struct DownloadBadge: View {
    let state: MusicDownload.State
    var body: some View {
        switch state {
        case .done: Image(systemName: "arrow.down.circle.fill").foregroundStyle(Theme.success).accessibilityLabel(Text("downloads.downloaded"))
        case .downloading, .queued: ProgressView().controlSize(.mini).accessibilityLabel(Text("downloads.in_progress"))
        case .paused: Image(systemName: "wifi.slash").foregroundStyle(Theme.mutedForeground).accessibilityLabel(Text("downloads.waiting_wifi"))
        case .failed: Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.destructive).accessibilityLabel(Text("music.dl.failed"))
        }
    }
}

/// Album: cover, play / shuffle / download, tracks (gapless continuation).
public struct AlbumView: View {
    @Environment(MusicEnvironment.self) private var env
    let albumId: String
    @State private var detail: AlbumDetail?
    @State private var error: String?

    public init(albumId: String) { self.albumId = albumId }

    public var body: some View {
        ScrollView {
            if let d = detail {
                VStack(spacing: 14) {
                    RemoteImage(url: env.cover(d.album.coverUrlPath), aspect: 1, placeholderSymbol: "music.note")
                        .frame(maxWidth: 260).clipShape(.rect(cornerRadius: 18)).shadow(radius: 20)
                    Text(d.album.name).font(Theme.heading(24)).multilineTextAlignment(.center).padding(.horizontal, 20)
                    if let artistId = d.album.artistId {
                        NavigationLink(value: MusicRoute.artist(artistId)) { Text(d.album.artist ?? "").font(Theme.body(15)) }
                    }
                    Text(meta(d)).font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                    HStack(spacing: 12) {
                        Button { env.play(d.tracks, at: 0) } label: { Label("action.play", systemImage: "play.fill").padding(.horizontal, 12) }
                            .buttonStyle(.glassProminent)
                        Button { env.play(d.tracks, at: 0, shuffle: true) } label: { Label("music.shuffle", systemImage: "shuffle").padding(.horizontal, 8) }
                            .buttonStyle(.glass)
                        if let dl = env.downloads { AlbumDownloadButton(tracks: d.tracks, downloads: dl) }
                    }
                    .controlSize(.large)
                    LazyVStack(spacing: 0) {
                        ForEach(Array(d.tracks.enumerated()), id: \.element.id) { i, t in
                            TrackRow(track: t, list: d.tracks, showNumber: true) { env.play(d.tracks, at: i) }
                        }
                    }
                }
                .padding(.vertical, 20)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else {
                StateView(kind: .loading).frame(minHeight: 360)
            }
        }
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func meta(_ d: AlbumDetail) -> String {
        var parts: [String] = []
        if let y = d.album.year { parts.append(String(y)) }
        parts.append(String(localized: "music.tracks_count \(d.tracks.count)"))
        parts.append(formatClock(d.tracks.reduce(0) { $0 + $1.durationSec }))
        return parts.joined(separator: " · ")
    }

    private func load() async {
        guard let s = env.store else { return }
        do { detail = try await s.album(albumId); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct AlbumDownloadButton: View {
    let tracks: [TrackCard]
    let downloads: MusicDownloads
    var body: some View {
        switch downloads.coverage(tracks) {
        case .all:
            Button(role: .destructive) { downloads.remove(tracks.map(\.id)) } label: { Image(systemName: "arrow.down.circle.fill") }
                .buttonStyle(.glass).accessibilityLabel(Text("music.dl.remove_album"))
        case .partial(let n, let total):
            Button { downloads.download(tracks) } label: { Label("\(n)/\(total)", systemImage: "arrow.down.circle.dotted") }
                .buttonStyle(.glass).accessibilityLabel(Text("music.dl.album"))
        case .none:
            Button { downloads.download(tracks) } label: { Image(systemName: "arrow.down.circle") }
                .buttonStyle(.glass).accessibilityLabel(Text("music.dl.album"))
        }
    }
}

public struct ArtistView: View {
    @Environment(MusicEnvironment.self) private var env
    let artistId: String
    @State private var detail: ArtistDetail?
    @State private var error: String?

    public init(artistId: String) { self.artistId = artistId }

    public var body: some View {
        ScrollView {
            if let d = detail {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 16) {
                        RemoteImage(url: env.cover(d.artist.coverUrlPath), aspect: 1, placeholderSymbol: "music.mic").frame(width: 110).clipShape(.circle)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(d.artist.name).font(Theme.heading(26))
                            Text("music.albums_count \(d.artist.albumCount)").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                            Button {
                                if let s = env.store { Task { await env.player.startMix(seed: d.artist.id, store: s) } }
                            } label: { Label("music.artist_radio", systemImage: "dot.radiowaves.left.and.right") }
                                .buttonStyle(.glass).controlSize(.small)
                        }
                    }
                    .padding(.horizontal, 20)
                    if !d.topTracks.isEmpty {
                        SectionHeader(title: String(localized: "music.top_tracks"))
                        ForEach(Array(d.topTracks.prefix(10).enumerated()), id: \.element.id) { i, t in
                            TrackRow(track: t, list: d.topTracks) { env.play(d.topTracks, at: i) }
                        }
                    }
                    SectionHeader(title: String(localized: "music.albums"))
                    ForEach(d.albums, id: \.id) { a in
                        NavigationLink(value: MusicRoute.album(a.id)) {
                            HStack {
                                RemoteImage(url: env.cover(a.coverUrlPath), aspect: 1, placeholderSymbol: "music.note").frame(width: 56).clipShape(.rect(cornerRadius: 8))
                                VStack(alignment: .leading) {
                                    Text(a.name).font(Theme.body(15, weight: .medium))
                                    Text(a.year.map(String.init) ?? "").font(.caption).foregroundStyle(Theme.mutedForeground)
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 20)
                        }
                        .buttonStyle(.plain)
                    }
                    if !d.similar.isEmpty {
                        SectionHeader(title: String(localized: "music.similar"))
                        ScrollView(.horizontal) {
                            LazyHStack(spacing: 12) {
                                ForEach(d.similar, id: \.id) { s in
                                    NavigationLink(value: MusicRoute.artist(s.id)) {
                                        CoverTile(url: env.cover(s.coverUrlPath), title: s.name, subtitle: "", symbol: "music.mic", round: true)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .padding(.horizontal, 20)
                        }
                        .scrollIndicators(.hidden)
                    }
                }
                .padding(.vertical, 20)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else {
                StateView(kind: .loading).frame(minHeight: 360)
            }
        }
        .background(Theme.background)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        guard let s = env.store else { return }
        do { detail = try await s.artist(artistId); error = nil } catch { self.error = error.localizedDescription }
    }
}

public struct PlaylistView: View {
    @Environment(MusicEnvironment.self) private var env
    let playlistId: String
    let name: String
    @State private var tracks: [TrackCard]?
    @State private var error: String?

    public init(playlistId: String, name: String) {
        self.playlistId = playlistId
        self.name = name
    }

    public var body: some View {
        List {
            if let tracks {
                if tracks.isEmpty {
                    StateView(kind: .empty("music.playlist_empty", "music.playlist_empty_hint"), symbol: "music.note.list").listRowBackground(Color.clear)
                } else {
                    Section {
                        HStack(spacing: 12) {
                            Button { env.play(tracks, at: 0) } label: { Label("action.play", systemImage: "play.fill") }.buttonStyle(.glassProminent)
                            Button { env.play(tracks, at: 0, shuffle: true) } label: { Label("music.shuffle", systemImage: "shuffle") }.buttonStyle(.glass)
                            if let dl = env.downloads { AlbumDownloadButton(tracks: tracks, downloads: dl) }
                        }
                        .listRowBackground(Color.clear)
                    }
                    ForEach(Array(tracks.enumerated()), id: \.element.id) { i, t in
                        TrackRow(track: t, list: tracks) { env.play(tracks, at: i) }
                            .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                    }
                }
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle(name)
        .task { await load() }
    }

    private func load() async {
        guard let s = env.store else { return }
        do { tracks = try await s.playlistTracks(playlistId); error = nil } catch { self.error = error.localizedDescription }
    }
}

/// Artists A–Z with a letter filter.
public struct ArtistsListView: View {
    @Environment(MusicEnvironment.self) private var env
    @State private var letter: String?
    @State private var page: ArtistPage?
    @State private var error: String?
    private let letters = ["#"] + "ABCDEFGHIJKLMNOPQRSTUVWXYZ".map(String.init)

    public init() {}

    public var body: some View {
        List {
            Section {
                ScrollView(.horizontal) {
                    HStack(spacing: 6) {
                        LetterChip(label: String(localized: "music.all"), selected: letter == nil) { letter = nil }
                        ForEach(letters, id: \.self) { l in LetterChip(label: l, selected: letter == l) { letter = l } }
                    }
                }
                .scrollIndicators(.hidden)
                .listRowBackground(Color.clear)
            }
            if let p = page {
                if p.items.isEmpty {
                    StateView(kind: .empty("music.no_artists", "music.empty_hint"), symbol: "music.mic").listRowBackground(Color.clear)
                }
                ForEach(p.items, id: \.id) { a in
                    NavigationLink(value: MusicRoute.artist(a.id)) {
                        HStack(spacing: 12) {
                            RemoteImage(url: env.cover(a.coverUrlPath), aspect: 1, placeholderSymbol: "music.mic").frame(width: 44).clipShape(.circle)
                            VStack(alignment: .leading) {
                                Text(a.name).font(Theme.body(15, weight: .medium))
                                Text("music.albums_count \(a.albumCount)").font(.caption).foregroundStyle(Theme.mutedForeground)
                            }
                        }
                    }
                    .listRowBackground(Color.clear)
                }
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("music.artists")
        .task(id: letter) { await load() }
    }

    private func load() async {
        guard let s = env.store else { return }
        do { page = try await s.artists(letter: letter, limit: 500); error = nil } catch { self.error = error.localizedDescription }
    }
}

struct LetterChip: View {
    let label: String
    let selected: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(label).font(Theme.body(13, weight: .semibold)).padding(.horizontal, 10).padding(.vertical, 6)
                .background(selected ? Theme.primary : Theme.card, in: .capsule)
                .foregroundStyle(selected ? Theme.primaryForeground : Theme.foreground)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Albums A–Z grid (paged).
public struct AlbumsGridView: View {
    @Environment(MusicEnvironment.self) private var env
    @State private var albums: [AlbumCard] = []
    @State private var total = -1
    @State private var error: String?
    @State private var loading = false
    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 14)]

    public init() {}

    public var body: some View {
        ScrollView {
            if total == 0 {
                StateView(kind: .empty("music.empty", "music.empty_hint"), symbol: "square.stack").frame(minHeight: 360)
            } else if let error, albums.isEmpty {
                StateView(kind: .error(error)) { Task { await more() } }
            }
            LazyVGrid(columns: columns, spacing: 18) {
                ForEach(uniqueAlbums(albums), id: \.id) { a in
                    NavigationLink(value: MusicRoute.album(a.id)) {
                        VStack(alignment: .leading, spacing: 4) {
                            RemoteImage(url: env.cover(a.coverUrlPath), aspect: 1, placeholderSymbol: "music.note").clipShape(.rect(cornerRadius: 12))
                            Text(a.name).font(Theme.body(13, weight: .medium)).lineLimit(1)
                            Text(a.artist ?? "").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                    .onAppear { if a.id == albums.last?.id { Task { await more() } } }
                }
            }
            .padding(20)
            if loading { ProgressView().padding() }
        }
        .background(Theme.background)
        .navigationTitle("music.albums")
        .task { if albums.isEmpty { await more() } }
    }

    private func more() async {
        guard let s = env.store, !loading, total < 0 || albums.count < total else { return }
        loading = true
        defer { loading = false }
        do {
            let p = try await s.albums(offset: albums.count, limit: 100)
            albums += p.items
            total = p.total
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

public struct PlaylistsListView: View {
    @Environment(MusicEnvironment.self) private var env
    @State private var lists: [PlaylistCard]?
    @State private var error: String?

    public init() {}

    public var body: some View {
        List {
            if let lists {
                if lists.isEmpty {
                    StateView(kind: .empty("music.no_playlists", "music.no_playlists_hint"), symbol: "music.note.list").listRowBackground(Color.clear)
                }
                ForEach(lists, id: \.id) { p in
                    NavigationLink(value: MusicRoute.playlist(id: p.id, name: p.name)) {
                        HStack(spacing: 12) {
                            RemoteImage(url: env.cover(p.coverUrlPath), aspect: 1, placeholderSymbol: "music.note.list").frame(width: 48).clipShape(.rect(cornerRadius: 8))
                            VStack(alignment: .leading) {
                                Text(p.name).font(Theme.body(15, weight: .medium))
                                Text("music.tracks_count \(p.songCount)").font(.caption).foregroundStyle(Theme.mutedForeground)
                            }
                        }
                    }
                    .listRowBackground(Color.clear)
                }
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }.listRowBackground(Color.clear)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("music.playlists")
        .task { await load() }
    }

    private func load() async {
        guard let s = env.store else { return }
        do { lists = try await s.playlists(); error = nil } catch { self.error = error.localizedDescription }
    }
}

/// Music search (artists, albums, tracks), debounced.
public struct MusicSearchView: View {
    @Environment(MusicEnvironment.self) private var env
    @State private var query = ""
    @State private var result: MusicSearch?
    @State private var loading = false
    @State private var error: String?

    public init() {}

    public var body: some View {
        List {
            if query.trimmingCharacters(in: .whitespaces).count < 2 {
                StateView(kind: .empty("music.search_prompt", "music.search_prompt_hint"), symbol: "magnifyingglass").listRowBackground(Color.clear)
            } else if let error {
                StateView(kind: .error(error)).listRowBackground(Color.clear)
            } else if loading && result == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if let r = result, r.artists.isEmpty && r.albums.isEmpty && r.tracks.isEmpty {
                StateView(kind: .empty("search.none", "search.none_hint"), symbol: "magnifyingglass").listRowBackground(Color.clear)
            }
            if let r = result {
                if !r.artists.isEmpty {
                    Section("music.artists") {
                        ForEach(r.artists.prefix(6), id: \.id) { a in
                            NavigationLink(value: MusicRoute.artist(a.id)) {
                                HStack { RemoteImage(url: env.cover(a.coverUrlPath), aspect: 1, placeholderSymbol: "music.mic").frame(width: 40).clipShape(.circle); Text(a.name) }
                            }
                        }
                    }
                }
                if !r.albums.isEmpty {
                    Section("search.albums") {
                        ForEach(r.albums.prefix(8), id: \.id) { a in
                            NavigationLink(value: MusicRoute.album(a.id)) {
                                HStack {
                                    RemoteImage(url: env.cover(a.coverUrlPath), aspect: 1, placeholderSymbol: "music.note").frame(width: 44).clipShape(.rect(cornerRadius: 6))
                                    VStack(alignment: .leading) { Text(a.name); Text(a.artist ?? "").font(.caption).foregroundStyle(Theme.mutedForeground) }
                                }
                            }
                        }
                    }
                }
                if !r.tracks.isEmpty {
                    Section("search.tracks") {
                        let list = Array(r.tracks.prefix(20))
                        ForEach(Array(list.enumerated()), id: \.element.id) { i, t in
                            TrackRow(track: t, list: list) { env.play(list, at: i) }.listRowInsets(EdgeInsets())
                        }
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .searchable(text: $query, prompt: Text("music.search_placeholder"))
        .task(id: query) { await search() }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2, let s = env.store else { result = nil; return }
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        loading = true
        defer { loading = false }
        do { result = try await s.search(q); error = nil } catch { self.error = error.localizedDescription }
    }
}
