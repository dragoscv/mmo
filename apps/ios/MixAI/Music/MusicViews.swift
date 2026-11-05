import MixaiCore
import SwiftUI

struct MusicHomeView: View {
    @Environment(AppModel.self) private var app
    @State private var home: MusicHome?
    @State private var error: String?

    var body: some View {
        ScrollView {
            if let h = home {
                if h.recent.isEmpty && h.newest.isEmpty && h.mostPlayed.isEmpty {
                    StateView(kind: .empty("music.empty", "music.empty_hint")).frame(minHeight: 360)
                }
                VStack(alignment: .leading, spacing: 24) {
                    albumRow("music.recent", h.recent)
                    albumRow("music.newest", h.newest)
                    if !h.mostPlayed.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeader(title: String(localized: "music.most_played"))
                            ForEach(Array(h.mostPlayed.prefix(10).enumerated()), id: \.element.id) { i, t in
                                TrackRow(track: t) { play(h.mostPlayed, i) }
                            }
                        }
                    }
                    albumRow("music.random", h.randomAlbums)
                }
                .padding(.vertical, 12)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else {
                StateView(kind: .loading).frame(minHeight: 360)
            }
        }
        .background(Theme.background)
        .navigationTitle("tab.music")
        .toolbar { ProfileToolbar() }
        .task(id: app.profileId) { await load() }
    }

    private func load() async {
        do { home = try await app.musicStore?.home() } catch { self.error = error.localizedDescription }
    }

    private func play(_ list: [TrackCard], _ i: Int) {
        if let s = app.musicStore { app.music.play(list, at: i, store: s, video: app.player) }
    }

    @ViewBuilder
    private func albumRow(_ title: LocalizedStringResource, _ albums: [AlbumCard]) -> some View {
        if !albums.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: String(localized: title))
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 12) {
                        ForEach(albums, id: \.id) { a in
                            NavigationLink(value: Route.album(a.id)) {
                                VStack(alignment: .leading, spacing: 4) {
                                    RemoteImage(url: app.musicStore?.coverURL(a.coverUrlPath), aspect: 1).frame(width: 140).clipShape(.rect(cornerRadius: 12))
                                    Text(a.name).font(Theme.body(13, weight: .medium)).lineLimit(1)
                                    Text(a.artist ?? "").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                                }
                                .frame(width: 140)
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

struct TrackRow: View {
    let track: TrackCard
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(track.title).font(Theme.body(15, weight: .medium)).lineLimit(1)
                    Text(track.artist ?? "").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                }
                Spacer()
                if track.hasSyncedLyrics { Image(systemName: "quote.bubble").foregroundStyle(Theme.mutedForeground).accessibilityLabel(Text("music.has_lyrics")) }
                Text(formatClock(track.durationSec)).font(Theme.body(12)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
            }
            .padding(.horizontal, 20).padding(.vertical, 6)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

struct AlbumView: View {
    @Environment(AppModel.self) private var app
    let albumId: String
    @State private var detail: AlbumDetail?

    var body: some View {
        ScrollView {
            if let d = detail {
                VStack(spacing: 14) {
                    RemoteImage(url: app.musicStore?.coverURL(d.album.coverUrlPath), aspect: 1).frame(width: 240).clipShape(.rect(cornerRadius: 18)).shadow(radius: 20)
                    Text(d.album.name).font(Theme.heading(24)).multilineTextAlignment(.center)
                    if let artistId = d.album.artistId {
                        NavigationLink(value: Route.artist(artistId)) { Text(d.album.artist ?? "").font(Theme.body(15)) }
                    }
                    Button { play(d.tracks, 0) } label: { Label("action.play", systemImage: "play.fill").padding(.horizontal, 20) }.buttonStyle(.glassProminent)
                    LazyVStack(spacing: 0) {
                        ForEach(Array(d.tracks.enumerated()), id: \.element.id) { i, t in TrackRow(track: t) { play(d.tracks, i) } }
                    }
                }
                .padding(.vertical, 20)
            } else {
                StateView(kind: .loading).frame(minHeight: 360)
            }
        }
        .background(Theme.background)
        .task { detail = try? await app.musicStore?.album(albumId) }
    }

    private func play(_ list: [TrackCard], _ i: Int) {
        if let s = app.musicStore { app.music.play(list, at: i, store: s, video: app.player) }
    }
}

struct ArtistView: View {
    @Environment(AppModel.self) private var app
    let artistId: String
    @State private var detail: ArtistDetail?

    var body: some View {
        ScrollView {
            if let d = detail {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(spacing: 16) {
                        RemoteImage(url: app.musicStore?.coverURL(d.artist.coverUrlPath), aspect: 1).frame(width: 110).clipShape(.circle)
                        VStack(alignment: .leading) {
                            Text(d.artist.name).font(Theme.heading(26))
                            Text("music.albums_count \(d.artist.albumCount)").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                        }
                    }
                    .padding(.horizontal, 20)
                    if !d.topTracks.isEmpty {
                        SectionHeader(title: String(localized: "music.top_tracks"))
                        ForEach(Array(d.topTracks.prefix(10).enumerated()), id: \.element.id) { i, t in
                            TrackRow(track: t) { if let s = app.musicStore { app.music.play(d.topTracks, at: i, store: s, video: app.player) } }
                        }
                    }
                    SectionHeader(title: String(localized: "music.albums"))
                    ForEach(d.albums, id: \.id) { a in
                        NavigationLink(value: Route.album(a.id)) {
                            HStack {
                                RemoteImage(url: app.musicStore?.coverURL(a.coverUrlPath), aspect: 1).frame(width: 56).clipShape(.rect(cornerRadius: 8))
                                VStack(alignment: .leading) { Text(a.name).font(Theme.body(15, weight: .medium)); Text(a.year.map(String.init) ?? "").font(.caption).foregroundStyle(Theme.mutedForeground) }
                                Spacer()
                            }
                            .padding(.horizontal, 20)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 20)
            } else {
                StateView(kind: .loading).frame(minHeight: 360)
            }
        }
        .background(Theme.background)
        .task { detail = try? await app.musicStore?.artist(artistId) }
    }
}

/// Now playing with synced lyrics (auto-scrolls to the active line).
struct NowPlayingView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let m = app.music
        VStack(spacing: 18) {
            Capsule().fill(Theme.muted).frame(width: 40, height: 5).padding(.top, 8)
            if let t = m.current {
                RemoteImage(url: app.musicStore?.coverURL(t.coverUrlPath), aspect: 1).frame(maxWidth: 280).clipShape(.rect(cornerRadius: 20)).shadow(radius: 24)
                VStack(spacing: 4) {
                    Text(t.title).font(Theme.heading(22)).lineLimit(1)
                    Text(t.artist ?? "").font(Theme.body(15)).foregroundStyle(Theme.mutedForeground)
                }
                Slider(value: Binding(get: { m.position }, set: { m.seek($0) }), in: 0...max(1, t.durationSec)).padding(.horizontal, 24)
                    .accessibilityLabel(Text("player.position"))
                HStack(spacing: 44) {
                    Button { m.previous() } label: { Image(systemName: "backward.fill").font(.title) }.accessibilityLabel(Text("music.previous"))
                    Button { m.toggle() } label: { Image(systemName: m.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 64)) }
                        .accessibilityLabel(Text(m.playing ? "player.pause" : "player.play"))
                    Button { m.next() } label: { Image(systemName: "forward.fill").font(.title) }.accessibilityLabel(Text("music.next"))
                }
                lyrics
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(Theme.foreground)
        .background(Theme.background)
    }

    @ViewBuilder
    private var lyrics: some View {
        let m = app.music
        if let synced = m.lyrics?.synced, !synced.isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(synced.enumerated()), id: \.offset) { i, l in
                            Text(l.text).font(Theme.heading(i == m.activeLyric ? 20 : 17, weight: i == m.activeLyric ? .bold : .medium))
                                .foregroundStyle(i == m.activeLyric ? Theme.foreground : Theme.mutedForeground)
                                .id(i)
                                .onTapGesture { m.seek(Double(l.timeMs) / 1000) }
                        }
                    }
                    .padding(.horizontal, 24)
                }
                .onChange(of: m.activeLyric) { _, i in if let i { withAnimation(.smooth) { proxy.scrollTo(i, anchor: .center) } } }
            }
        } else if let plain = m.lyrics?.plain {
            ScrollView { Text(plain).font(Theme.body(15)).foregroundStyle(Theme.mutedForeground).padding(.horizontal, 24) }
        }
    }
}
