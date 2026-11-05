import MixaiCore
import SwiftUI

/// Movie / show page: backdrop header, Play/Resume, My list, versions, seasons + episodes, cast,
/// where to watch (provider links), trailer, more like this.
struct TitleView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    let kind: MediaKind
    let tmdbId: Int
    let ns: Namespace.ID
    @State private var data: MediaTitleResponse?
    @State private var error: String?
    @State private var target: PlayTarget?
    @State private var season: Int?
    @State private var seasonData: MediaSeasonResponse?
    @State private var inList = false
    @State private var preferredFile: String?

    var body: some View {
        Group {
            if let d = data { content(d) } else if let error { StateView(kind: .error(error)) { Task { await load() } } } else { StateView(kind: .loading) }
        }
        .background(Theme.background)
        .toolbarBackgroundVisibility(.hidden, for: .navigationBar)
        .task { await load() }
    }

    private func load() async {
        guard let store = app.media else { return }
        error = nil
        do {
            let d = try await store.title(kind: kind, tmdbId: tmdbId)
            data = d
            inList = d.inWatchlist ?? false
            target = await PlayResolver.resolve(d, store: store, preferred: preferredFile)
            if d.title.kind == .tv, season == nil {
                let firstSeason = d.nextUp?.season ?? d.title.seasons?.first(where: { $0.seasonNumber > 0 })?.seasonNumber ?? 1
                await loadSeason(firstSeason)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadSeason(_ n: Int) async {
        season = n
        seasonData = try? await app.media?.season(tmdbId: tmdbId, number: n)
    }

    private func content(_ d: MediaTitleResponse) -> some View {
        let t = d.title
        return ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ZStack(alignment: .bottomLeading) {
                    RemoteImage(url: app.client?.tmdbImageURL(size: TmdbSize.backdrop(1280), path: t.backdropPath ?? t.posterPath), aspect: 16 / 11)
                        .overlay(Theme.heroScrim)
                    VStack(alignment: .leading, spacing: 8) {
                        Text(t.title).font(Theme.heading(30)).lineLimit(3)
                        if let tag = t.tagline, !tag.isEmpty { Text(tag).font(Theme.body(14)).italic().foregroundStyle(.white.opacity(0.8)) }
                        chips(d)
                    }
                    .padding(20)
                }
                actions(d).padding(.horizontal, 20)
                if let o = t.overview, !o.isEmpty {
                    Text(o).font(Theme.body(15)).foregroundStyle(Theme.foreground.opacity(0.9)).padding(.horizontal, 20)
                }
                versions(d)
                if t.kind == .tv { seasons(t) }
                cast(t)
                offers(d)
                related(t)
                Color.clear.frame(height: 40)
            }
        }
        .ignoresSafeArea(edges: .top)
    }

    private func chips(_ d: MediaTitleResponse) -> some View {
        let t = d.title
        var items: [String] = []
        if let y = PlayResolver.year(t.releaseDate) { items.append(y) }
        if let r = t.runtime, r > 0 { items.append(String(localized: "title.minutes \(r)")) }
        if let n = t.numberOfSeasons, n > 0 { items.append(String(localized: "title.seasons \(n)")) }
        if let a = t.age { items.append("\(a)+") }
        items += PlayResolver.formatChips(d.files)
        let genres = t.genres.compactMap { $0["name"]?.stringValue }.prefix(2)
        return HStack(spacing: 6) {
            ForEach(items + genres, id: \.self) { s in
                Text(s).font(Theme.body(12, weight: .semibold)).padding(.horizontal, 9).padding(.vertical, 4).glassCard(cornerRadius: 9)
            }
        }
    }

    private func actions(_ d: MediaTitleResponse) -> some View {
        HStack(spacing: 12) {
            if let target {
                Button { play(target, title: d.title.title) } label: {
                    Label(target.resumeSec != nil ? "action.resume" : "action.play", systemImage: "play.fill").frame(maxWidth: .infinity).padding(.vertical, 4)
                }
                .buttonStyle(.glassProminent)
                if let left = target.leftMin { Text("title.left \(left)").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground) }
            } else {
                Text("title.not_in_library").font(Theme.body(14)).foregroundStyle(Theme.mutedForeground).frame(maxWidth: .infinity, alignment: .leading)
            }
            Button {
                let on = !inList
                inList = on
                Task { try? await app.media?.setWatchlist(kind: kind, tmdbId: tmdbId, on: on); await app.homeStore?.invalidate() }
            } label: { Image(systemName: inList ? "checkmark" : "plus").frame(width: 28, height: 28) }
            .buttonStyle(.glass)
            .accessibilityLabel(Text(inList ? "title.remove_list" : "title.add_list"))
            if let key = PlayResolver.trailerKey(d.title), let url = URL(string: "https://www.youtube.com/watch?v=\(key)") {
                Button { openURL(url) } label: { Image(systemName: "play.rectangle").frame(width: 28, height: 28) }
                    .buttonStyle(.glass)
                    .accessibilityLabel(Text("title.trailer"))
            }
        }
        .controlSize(.large)
    }

    @ViewBuilder
    private func versions(_ d: MediaTitleResponse) -> some View {
        let movies = d.files.filter { !PlayResolver.isEpisode($0) }
        if movies.count > 1 {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: String(localized: "title.versions"))
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(movies.sorted { $0.version.rank > $1.version.rank }, id: \.serverFileId) { f in
                            Button(f.version.label) {
                                preferredFile = f.serverFileId
                                target = PlayResolver.movie(d, preferred: f.serverFileId)
                            }
                            .buttonStyle(.glass)
                            .tint(target?.fileId == f.serverFileId ? Theme.primary : nil)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    @ViewBuilder
    private func seasons(_ t: TitleDetails) -> some View {
        let list = (t.seasons ?? []).filter { $0.seasonNumber > 0 }
        VStack(alignment: .leading, spacing: 10) {
            if !list.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(list, id: \.seasonNumber) { s in
                            Button(String(localized: "title.season \(s.seasonNumber)")) { Task { await loadSeason(s.seasonNumber) } }
                                .buttonStyle(.glass)
                                .tint(season == s.seasonNumber ? Theme.primary : nil)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
            if let sd = seasonData {
                ForEach(sd.episodes, id: \.episodeNumber) { ep in episodeRow(ep, show: t) }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
    }

    private func episodeRow(_ ep: SeasonEpisode, show: TitleDetails) -> some View {
        let t = PlayResolver.episode(tmdbId: tmdbId, season: ep.seasonNumber, episode: ep.episodeNumber, files: ep.files, progress: ep.progress)
        return Button {
            if let t { play(t, title: show.title, subtitle: "S\(ep.seasonNumber) E\(ep.episodeNumber) · \(ep.name)") }
        } label: {
            HStack(alignment: .top, spacing: 12) {
                RemoteImage(url: app.client?.tmdbImageURL(size: TmdbSize.backdrop(300), path: ep.stillPath), aspect: 16 / 9)
                    .frame(width: 140)
                    .clipShape(.rect(cornerRadius: 10))
                    .overlay(alignment: .bottom) {
                        if let p = ep.progress, p.durationSec > 0, !p.completed {
                            GeometryReader { g in Capsule().fill(Theme.primary).frame(width: g.size.width * min(1, p.positionSec / p.durationSec), height: 3) }
                                .frame(height: 3).padding(5)
                        }
                    }
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(ep.episodeNumber). \(ep.name)").font(Theme.body(15, weight: .semibold)).lineLimit(2)
                    if let o = ep.overview { Text(o).font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(3) }
                    if t == nil { Text("title.not_in_library").font(Theme.body(11)).foregroundStyle(Theme.mutedForeground) }
                    if ep.progress?.completed == true { Label("title.watched", systemImage: "checkmark.circle.fill").font(Theme.body(11)).foregroundStyle(Theme.success) }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(t == nil)
    }

    @ViewBuilder
    private func cast(_ t: TitleDetails) -> some View {
        if !t.cast.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: String(localized: "title.cast"))
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 14) {
                        ForEach(t.cast.prefix(20), id: \.id) { p in
                            VStack(spacing: 6) {
                                RemoteImage(url: app.client?.tmdbImageURL(size: "w185", path: p.profilePath), aspect: 1).frame(width: 72).clipShape(.circle)
                                Text(p.name).font(Theme.body(12, weight: .medium)).lineLimit(2).multilineTextAlignment(.center)
                                Text(p.role).font(Theme.body(11)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                            }
                            .frame(width: 84)
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    @ViewBuilder
    private func offers(_ d: MediaTitleResponse) -> some View {
        if !d.availability.offers.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: String(localized: "title.where_to_watch"))
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(Array(d.availability.offers.enumerated()), id: \.offset) { _, o in
                            Button {
                                if let u = URL(string: o.link ?? o.launch.web) ?? URL(string: o.launch.search) { openURL(u) }
                            } label: {
                                HStack(spacing: 8) {
                                    RemoteImage(url: app.client?.tmdbImageURL(size: "w92", path: o.logo), aspect: 1).frame(width: 28).clipShape(.rect(cornerRadius: 6))
                                    VStack(alignment: .leading, spacing: 0) {
                                        Text(o.name).font(Theme.body(13, weight: .semibold))
                                        Text(LocalizedStringKey(stringLiteral: "offer." + o.type.rawValue)).font(Theme.body(11)).foregroundStyle(Theme.mutedForeground)
                                    }
                                }
                                .padding(.horizontal, 10).padding(.vertical, 6)
                            }
                            .buttonStyle(.glass)
                        }
                    }
                    .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
                if !d.availability.attribution.isEmpty {
                    Text("title.data_by \(d.availability.attribution.joined(separator: ", "))").font(Theme.body(11)).foregroundStyle(Theme.mutedForeground).padding(.horizontal, 20)
                }
            }
        }
    }

    @ViewBuilder
    private func related(_ t: TitleDetails) -> some View {
        let more = uniqueCards(t.recommendations + t.similar)
        if !more.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: String(localized: "title.more_like"))
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 12) { ForEach(more.prefix(20), id: \.self) { c in PosterCard(card: c, width: 110, ns: ns) } }
                        .padding(.horizontal, 20)
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    private func play(_ t: PlayTarget, title: String, subtitle: String? = nil) {
        app.player.start(PlayRequest(source: .file(fileId: t.fileId, ref: t.ref, startSec: t.resumeSec ?? 0), title: title, subtitle: subtitle, artwork: nil), app: app)
    }
}
