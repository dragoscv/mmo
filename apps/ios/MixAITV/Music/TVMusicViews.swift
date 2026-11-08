import MixaiCore
import SwiftUI

/// Routes inside the Music tab (its own NavigationStack).
enum TVMusicRoute: Hashable {
    case album(String)
    case artist(String)
    case playlist(PlaylistCard)
    case nowPlaying
}

/// Music tab of MixAI TV on Apple TV (WP17-45): rows from `/media/music/home`, album / artist / playlist pages and a
/// Now Playing screen with synced lyrics and the queue. Plays on the built-in `TVMusicPlayer`.
struct TVMusicTab: View {
    @Environment(TVModel.self) private var model
    @State private var path: [TVMusicRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            TVMusicHome(path: $path)
                .navigationDestination(for: TVMusicRoute.self) { r in
                    switch r {
                    case .album(let id): TVAlbumView(albumId: id, path: $path)
                    case .artist(let id): TVArtistView(artistId: id, path: $path)
                    case .playlist(let p): TVPlaylistView(playlist: p, path: $path)
                    case .nowPlaying: TVNowPlayingView(path: $path)
                    }
                }
        }
    }
}

private struct TVMusicHome: View {
    @Environment(TVModel.self) private var model
    @Binding var path: [TVMusicRoute]
    @State private var home: MusicHome?
    @State private var error: String?
    @State private var mixFailed = false

    var body: some View {
        Group {
            if let home {
                ScrollView {
                    VStack(alignment: .leading, spacing: 56) {
                        actions
                        if home.recent.isEmpty && home.newest.isEmpty && home.randomAlbums.isEmpty && home.playlists.isEmpty {
                            TVStateView(kind: .empty("music.empty", "music.empty_hint"))
                        }
                        albumRow("music.recent", home.recent)
                        albumRow("music.newest", home.newest)
                        if !home.mostPlayed.isEmpty {
                            TVMusicSection("music.most_played") {
                                ForEach(Array(home.mostPlayed.prefix(20).enumerated()), id: \.element.id) { i, t in
                                    TVTrackChip(track: t) { play(home.mostPlayed, at: i) }
                                }
                            }
                        }
                        if !home.playlists.isEmpty {
                            TVMusicSection("music.playlists") {
                                ForEach(home.playlists, id: \.id) { p in
                                    TVCoverButton(url: model.music?.coverURL(p.coverUrlPath), title: p.name,
                                                  subtitle: String(localized: "music.tracks_count \(p.songCount)")) { path.append(.playlist(p)) }
                                }
                            }
                        }
                        albumRow("music.random", home.randomAlbums)
                    }
                    .padding(.vertical, 40)
                }
            } else if let error {
                TVStateView(kind: .error(error)) { Task { await load() } }
            } else {
                TVStateView(kind: .loading)
            }
        }
        .task(id: model.profileId) { await load() }
    }

    private var actions: some View {
        HStack(spacing: 32) {
            Button { Task { await mix() } } label: {
                Label("music.start_mix", systemImage: "infinity").font(TVTheme.body(30, weight: .semibold))
            }
            if model.musicPlayer.current != nil {
                Button { path.append(.nowPlaying) } label: {
                    Label("music.open_now_playing", systemImage: "waveform").font(TVTheme.body(30, weight: .semibold))
                }
            }
            if mixFailed { Text("music.mix_empty").font(TVTheme.body(24)).foregroundStyle(TVTheme.mutedForeground) }
        }
        .padding(.horizontal, 80)
    }

    @ViewBuilder
    private func albumRow(_ title: LocalizedStringKey, _ albums: [AlbumCard]) -> some View {
        if !albums.isEmpty {
            TVMusicSection(title) {
                ForEach(albums, id: \.id) { a in
                    TVCoverButton(url: model.music?.coverURL(a.coverUrlPath), title: a.name, subtitle: a.artist) { path.append(.album(a.id)) }
                }
            }
        }
    }

    private func load() async {
        guard let store = model.music else { return }
        do { home = try await store.home(); error = nil } catch { if !tvIsCancellation(error) { self.error = error.localizedDescription } }
    }

    private func play(_ tracks: [TrackCard], at i: Int) {
        guard let s = model.music else { return }
        model.musicPlayer.play(tracks, at: i, store: s)
        path.append(.nowPlaying)
    }

    private func mix() async {
        guard let s = model.music else { return }
        if await model.musicPlayer.startMix(store: s) { mixFailed = false; path.append(.nowPlaying) } else { mixFailed = true }
    }
}

// MARK: album / artist / playlist

private struct TVAlbumView: View {
    @Environment(TVModel.self) private var model
    let albumId: String
    @Binding var path: [TVMusicRoute]
    @State private var detail: AlbumDetail?
    @State private var error: String?

    var body: some View {
        Group {
            if let d = detail {
                TVTrackListPage(cover: model.music?.coverURL(d.album.coverUrlPath), title: d.album.name,
                                subtitle: [d.album.artist, d.album.year.map(String.init)].compactMap { $0 }.joined(separator: " · "),
                                tracks: d.tracks, numbered: true, path: $path,
                                artistId: d.album.artistId)
            } else if let error {
                TVStateView(kind: .error(error)) { Task { await load() } }
            } else {
                TVStateView(kind: .loading)
            }
        }
        .task(id: albumId) { await load() }
    }

    private func load() async {
        guard let s = model.music else { return }
        do { detail = try await s.album(albumId); error = nil } catch { if !tvIsCancellation(error) { self.error = error.localizedDescription } }
    }
}

private struct TVPlaylistView: View {
    @Environment(TVModel.self) private var model
    let playlist: PlaylistCard
    @Binding var path: [TVMusicRoute]
    @State private var tracks: [TrackCard]?
    @State private var error: String?

    var body: some View {
        Group {
            if let tracks {
                if tracks.isEmpty {
                    TVStateView(kind: .empty("music.playlist_empty", "music.playlist_empty_hint"))
                } else {
                    TVTrackListPage(cover: model.music?.coverURL(playlist.coverUrlPath), title: playlist.name,
                                    subtitle: String(localized: "music.tracks_count \(playlist.songCount)"), tracks: tracks, numbered: false, path: $path)
                }
            } else if let error {
                TVStateView(kind: .error(error)) { Task { await load() } }
            } else {
                TVStateView(kind: .loading)
            }
        }
        .task(id: playlist.id) { await load() }
    }

    private func load() async {
        guard let s = model.music else { return }
        do { tracks = try await s.playlistTracks(playlist.id); error = nil } catch { if !tvIsCancellation(error) { self.error = error.localizedDescription } }
    }
}

private struct TVArtistView: View {
    @Environment(TVModel.self) private var model
    let artistId: String
    @Binding var path: [TVMusicRoute]
    @State private var detail: ArtistDetail?
    @State private var error: String?

    var body: some View {
        Group {
            if let d = detail {
                ScrollView {
                    VStack(alignment: .leading, spacing: 48) {
                        HStack(spacing: 48) {
                            TVRemoteImage(url: model.music?.coverURL(d.artist.coverUrlPath), aspect: 1)
                                .frame(width: 260).clipShape(Circle())
                            VStack(alignment: .leading, spacing: 20) {
                                Text(d.artist.name).font(TVTheme.heading(64)).lineLimit(2)
                                Text("music.albums_count \(d.artist.albumCount)").font(TVTheme.body(28)).foregroundStyle(TVTheme.mutedForeground)
                                HStack(spacing: 24) {
                                    if !d.topTracks.isEmpty {
                                        Button { play(d.topTracks, 0) } label: { Label("action.play", systemImage: "play.fill") }
                                    }
                                    Button { Task { await radio(d.artist) } } label: { Label("music.artist_radio", systemImage: "dot.radiowaves.left.and.right") }
                                }
                            }
                        }
                        .padding(.horizontal, 80)
                        if !d.topTracks.isEmpty {
                            TVMusicSection("music.top_tracks") {
                                ForEach(Array(d.topTracks.prefix(20).enumerated()), id: \.element.id) { i, t in
                                    TVTrackChip(track: t) { play(d.topTracks, i) }
                                }
                            }
                        }
                        if !d.albums.isEmpty {
                            TVMusicSection("music.albums") {
                                ForEach(d.albums, id: \.id) { a in
                                    TVCoverButton(url: model.music?.coverURL(a.coverUrlPath), title: a.name, subtitle: a.year.map(String.init)) { path.append(.album(a.id)) }
                                }
                            }
                        }
                        if !d.similar.isEmpty {
                            TVMusicSection("music.similar") {
                                ForEach(d.similar, id: \.id) { s in
                                    TVCoverButton(url: model.music?.coverURL(s.coverUrlPath), title: s.name, subtitle: nil, round: true) { path.append(.artist(s.id)) }
                                }
                            }
                        }
                    }
                    .padding(.vertical, 40)
                }
            } else if let error {
                TVStateView(kind: .error(error)) { Task { await load() } }
            } else {
                TVStateView(kind: .loading)
            }
        }
        .task(id: artistId) { await load() }
    }

    private func load() async {
        guard let s = model.music else { return }
        do { detail = try await s.artist(artistId); error = nil } catch { if !tvIsCancellation(error) { self.error = error.localizedDescription } }
    }

    private func play(_ tracks: [TrackCard], _ i: Int) {
        guard let s = model.music else { return }
        model.musicPlayer.play(tracks, at: i, store: s)
        path.append(.nowPlaying)
    }

    private func radio(_ a: ArtistCard) async {
        guard let s = model.music, let tracks = try? await s.radio(seed: a.id), !tracks.isEmpty else { return }
        play(tracks, 0)
    }
}

/// Cover + title + actions on the left, focusable track list on the right (album and playlist pages).
private struct TVTrackListPage: View {
    @Environment(TVModel.self) private var model
    let cover: URL?
    let title: String
    let subtitle: String
    let tracks: [TrackCard]
    let numbered: Bool
    @Binding var path: [TVMusicRoute]
    var artistId: String?

    var body: some View {
        HStack(alignment: .top, spacing: 64) {
            VStack(alignment: .leading, spacing: 24) {
                TVRemoteImage(url: cover, aspect: 1).frame(width: 420).clipShape(RoundedRectangle(cornerRadius: 16))
                Text(title).font(TVTheme.heading(44)).lineLimit(3)
                Text(subtitle).font(TVTheme.body(26)).foregroundStyle(TVTheme.mutedForeground).lineLimit(2)
                HStack(spacing: 20) {
                    Button { play(0, shuffle: false) } label: { Label("action.play", systemImage: "play.fill") }
                    Button { play(0, shuffle: true) } label: { Label("music.shuffle", systemImage: "shuffle") }
                }
                if let artistId, !artistId.isEmpty {
                    Button { path.append(.artist(artistId)) } label: { Label("music.go_artist", systemImage: "person") }
                }
            }
            .frame(width: 420)
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(Array(tracks.enumerated()), id: \.offset) { i, t in
                        TVTrackRow(track: t, number: numbered ? (t.track ?? i + 1) : nil, current: model.musicPlayer.current?.id == t.id) { play(i, shuffle: false) }
                    }
                }
                .padding(.vertical, 20)
            }
        }
        .padding(.horizontal, 80)
        .padding(.vertical, 40)
    }

    private func play(_ i: Int, shuffle: Bool) {
        guard let s = model.music else { return }
        model.musicPlayer.play(tracks, at: i, store: s, shuffle: shuffle)
        path.append(.nowPlaying)
    }
}

// MARK: Now Playing

private struct TVNowPlayingView: View {
    @Environment(TVModel.self) private var model
    @Binding var path: [TVMusicRoute]
    @State private var panel = 0 // 0 lyrics, 1 queue
    @State private var lyrics: Lyrics?
    @FocusState private var playFocused: Bool

    var body: some View {
        let p = model.musicPlayer
        Group {
            if let t = p.current {
                HStack(alignment: .top, spacing: 72) {
                    VStack(alignment: .leading, spacing: 28) {
                        TVRemoteImage(url: model.music?.coverURL(t.coverUrlPath), aspect: 1)
                            .frame(width: 560).clipShape(RoundedRectangle(cornerRadius: 20)).shadow(radius: 30)
                        Text(t.title).font(TVTheme.heading(48)).lineLimit(2)
                        Text([t.artist, t.album].compactMap { $0 }.joined(separator: " · "))
                            .font(TVTheme.body(28)).foregroundStyle(TVTheme.mutedForeground).lineLimit(1)
                        ProgressView(value: min(p.position, max(p.duration, 1)), total: max(p.duration, 1))
                            .tint(TVTheme.primary)
                        HStack {
                            Text(fmt(p.position)); Spacer(); Text(fmt(p.duration))
                        }
                        .font(TVTheme.body(22)).foregroundStyle(TVTheme.mutedForeground).monospacedDigit()
                        HStack(spacing: 28) {
                            Button { p.setShuffle(!p.queue.shuffled) } label: {
                                Image(systemName: "shuffle").foregroundStyle(p.queue.shuffled ? TVTheme.primary : TVTheme.foreground)
                            }
                            .accessibilityLabel(Text("music.shuffle"))
                            Button { p.previous() } label: { Image(systemName: "backward.fill") }.accessibilityLabel(Text("music.previous"))
                            Button { p.toggle() } label: { Image(systemName: p.playing ? "pause.fill" : "play.fill").font(.system(size: 44)) }
                                .focused($playFocused)
                                .accessibilityLabel(Text(p.playing ? "music.pause" : "action.play"))
                            Button { p.next() } label: { Image(systemName: "forward.fill") }.accessibilityLabel(Text("music.next"))
                            Button { p.cycleRepeat() } label: {
                                Image(systemName: p.queue.repeatMode == .one ? "repeat.1" : "repeat")
                                    .foregroundStyle(p.queue.repeatMode == .off ? TVTheme.foreground : TVTheme.primary)
                            }
                            .accessibilityLabel(Text(repeatLabel(p.queue.repeatMode)))
                        }
                        .font(.system(size: 32))
                    }
                    .frame(width: 560)
                    VStack(alignment: .leading, spacing: 24) {
                        Picker("", selection: $panel) {
                            Text("music.lyrics").tag(0)
                            Text("music.queue").tag(1)
                        }
                        .pickerStyle(.segmented)
                        if panel == 0 { lyricsPanel(p) } else { queuePanel(p) }
                    }
                }
                .padding(.horizontal, 80)
                .padding(.vertical, 50)
                .task(id: t.id) {
                    lyrics = nil
                    lyrics = try? await model.music?.lyrics(t.id)
                }
                .onAppear { playFocused = true }
            } else {
                TVStateView(kind: .empty("music.nothing_playing", "music.nothing_playing_hint"))
            }
        }
        .background { TVTheme.background.ignoresSafeArea() }
    }

    @ViewBuilder
    private func lyricsPanel(_ p: TVMusicPlayer) -> some View {
        if let synced = lyrics?.synced, !synced.isEmpty {
            let active = activeLyricIndex(synced, ms: Int(p.position * 1000))
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(Array(synced.enumerated()), id: \.offset) { i, line in
                            Text(line.text.isEmpty ? " " : line.text)
                                .font(TVTheme.heading(i == active ? 40 : 32, weight: i == active ? .bold : .medium))
                                .foregroundStyle(i == active ? TVTheme.foreground : TVTheme.mutedForeground.opacity(0.7))
                                .id(i)
                        }
                    }
                    .padding(.vertical, 200)
                }
                .onChange(of: active) { _, a in if let a { withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(a, anchor: .center) } } }
            }
        } else if let plain = lyrics?.plain, !plain.isEmpty {
            ScrollView { Text(plain).font(TVTheme.body(30)).padding(.vertical, 20) }
        } else {
            TVStateView(kind: .empty("music.no_lyrics", "music.no_lyrics_hint"))
        }
    }

    private func queuePanel(_ p: TVMusicPlayer) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(Array(p.queue.tracks.enumerated()), id: \.offset) { i, t in
                        TVTrackRow(track: t, number: nil, current: i == p.queue.index) { p.skip(to: i) }.id(i)
                    }
                }
                .padding(.vertical, 20)
            }
            .onAppear { proxy.scrollTo(p.queue.index, anchor: .top) }
        }
    }

    private func repeatLabel(_ r: RepeatMode) -> LocalizedStringKey {
        switch r { case .off: "music.repeat_off"; case .all: "music.repeat_all"; case .one: "music.repeat_one" }
    }

    private func fmt(_ s: Double) -> String {
        let t = Int(max(0, s.isFinite ? s : 0))
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
}

// MARK: components

private struct TVMusicSection<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder var content: Content
    init(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(title).font(TVTheme.heading(36)).accessibilityAddTraits(.isHeader).padding(.horizontal, 80)
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 40) { content }.padding(.horizontal, 80).padding(.vertical, 30)
            }
            .scrollClipDisabled()
        }
    }
}

private struct TVCoverButton: View {
    let url: URL?
    let title: String
    let subtitle: String?
    var round = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            TVRemoteImage(url: url, aspect: 1)
                .frame(width: 260)
                .clipShape(round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 12)))
        }
        .buttonStyle(.card)
        .accessibilityLabel(Text([title, subtitle].compactMap { $0 }.joined(separator: ", ")))
        .overlay(alignment: .bottomLeading) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(TVTheme.body(24, weight: .semibold)).lineLimit(1)
                if let subtitle { Text(subtitle).font(TVTheme.body(20)).foregroundStyle(TVTheme.mutedForeground).lineLimit(1) }
            }
            .frame(width: 260, alignment: .leading)
            .offset(y: 70)
            .accessibilityHidden(true)
        }
        .padding(.bottom, 70)
    }
}

private struct TVTrackChip: View {
    let track: TrackCard
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                Text(track.title).font(TVTheme.body(26, weight: .semibold)).lineLimit(1)
                Text(track.artist ?? "").font(TVTheme.body(22)).foregroundStyle(TVTheme.mutedForeground).lineLimit(1)
            }
            .frame(width: 360, alignment: .leading)
            .padding(.vertical, 8)
        }
    }
}

private struct TVTrackRow: View {
    let track: TrackCard
    let number: Int?
    let current: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 24) {
                if let number { Text("\(number)").font(TVTheme.body(24)).foregroundStyle(TVTheme.mutedForeground).frame(width: 48, alignment: .trailing) }
                VStack(alignment: .leading, spacing: 4) {
                    Text(track.title).font(TVTheme.body(28, weight: current ? .bold : .regular))
                        .foregroundStyle(current ? TVTheme.primary : TVTheme.foreground).lineLimit(1)
                    if let a = track.artist { Text(a).font(TVTheme.body(22)).foregroundStyle(TVTheme.mutedForeground).lineLimit(1) }
                }
                Spacer()
                if track.hasSyncedLyrics { Image(systemName: "quote.bubble").foregroundStyle(TVTheme.mutedForeground).accessibilityLabel(Text("music.has_lyrics")) }
                Text(String(format: "%d:%02d", Int(track.durationSec) / 60, Int(track.durationSec) % 60))
                    .font(TVTheme.body(22)).foregroundStyle(TVTheme.mutedForeground).monospacedDigit()
            }
            .padding(.horizontal, 12)
        }
    }
}
