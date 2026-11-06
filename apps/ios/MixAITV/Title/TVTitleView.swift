import MixaiCore
import SwiftUI

/// Movie / show page: backdrop, Play/Resume, My list, seasons + episodes, cast, more like this.
/// Streaming-provider offers are informational only (tvOS has no browser to open them).
struct TVTitleView: View {
    @Environment(TVModel.self) private var model
    let kind: MediaKind
    let tmdbId: Int
    @State private var data: MediaTitleResponse?
    @State private var error: String?
    @State private var target: PlayTarget?
    @State private var season: Int?
    @State private var seasonData: MediaSeasonResponse?
    @State private var inList = false

    var body: some View {
        Group {
            if let d = data { content(d) } else if let error {
                TVStateView(kind: .error(error)) { Task { await load() } }
            } else {
                TVStateView(kind: .loading)
            }
        }
        .background(TVTheme.background.ignoresSafeArea())
        .task { await load() }
    }

    private func load() async {
        guard let store = model.media else { return }
        error = nil
        do {
            let d = try await store.title(kind: kind, tmdbId: tmdbId)
            data = d
            inList = d.inWatchlist ?? false
            target = await PlayResolver.resolve(d, store: store)
            if d.title.kind == .tv, season == nil {
                let first = d.nextUp?.season ?? d.title.seasons?.first(where: { $0.seasonNumber > 0 })?.seasonNumber ?? 1
                await loadSeason(first)
            }
        } catch {
            if !tvIsCancellation(error) { self.error = error.localizedDescription }
        }
    }

    private func loadSeason(_ n: Int) async {
        season = n
        seasonData = try? await model.media?.season(tmdbId: tmdbId, number: n)
    }

    private func content(_ d: MediaTitleResponse) -> some View {
        let t = d.title
        return ZStack(alignment: .topLeading) {
            TVRemoteImage(url: model.client?.tmdbImageURL(size: TmdbSize.backdrop(1280), path: t.backdropPath ?? t.posterPath), aspect: 16 / 9)
                .frame(maxWidth: .infinity)
                .overlay(TVTheme.heroScrimLeading)
                .overlay(TVTheme.heroScrimBottom)
                .ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: 44) {
                    VStack(alignment: .leading, spacing: 18) {
                        Text(t.title).font(TVTheme.heading(80)).lineLimit(2)
                        if let tag = t.tagline, !tag.isEmpty { Text(tag).font(TVTheme.body(28)).italic().foregroundStyle(.white.opacity(0.8)) }
                        chips(d)
                        if let o = t.overview, !o.isEmpty {
                            Text(o).font(TVTheme.body(28)).foregroundStyle(.white.opacity(0.9)).lineLimit(4).frame(maxWidth: 1100, alignment: .leading)
                        }
                    }
                    .padding(.top, 180)
                    actions(d)
                    if t.kind == .tv { seasons(t) }
                    cast(t)
                    related(t)
                }
                .padding(.horizontal, 80)
                .padding(.bottom, 80)
            }
        }
    }

    private func chips(_ d: MediaTitleResponse) -> some View {
        let t = d.title
        var items: [String] = []
        if let y = PlayResolver.year(t.releaseDate) { items.append(y) }
        if let r = t.runtime, r > 0 { items.append(String(localized: "title.minutes \(r)")) }
        if let n = t.numberOfSeasons, n > 0 { items.append(String(localized: "title.seasons \(n)")) }
        if let a = t.age { items.append("\(a)+") }
        items += PlayResolver.formatChips(d.files)
        items += t.genres.compactMap { $0["name"]?.stringValue }.prefix(2)
        return HStack(spacing: 12) {
            ForEach(items, id: \.self) { s in
                Text(s).font(TVTheme.body(22, weight: .semibold)).padding(.horizontal, 14).padding(.vertical, 7)
                    .background(.ultraThinMaterial, in: .rect(cornerRadius: 12))
            }
        }
    }

    private func actions(_ d: MediaTitleResponse) -> some View {
        HStack(spacing: 30) {
            if let target {
                Button { model.play(target, title: d.title.title, subtitle: target.ref.season.map { "S\($0) E\(target.ref.episode ?? 0)" }) } label: {
                    Label(target.resumeSec != nil ? "action.resume" : "action.play", systemImage: "play.fill").padding(.horizontal, 20)
                }
                if let left = target.leftMin { Text("title.left \(left)").font(TVTheme.body(24)).foregroundStyle(TVTheme.mutedForeground) }
            } else {
                Text("title.not_in_library").font(TVTheme.body(28)).foregroundStyle(TVTheme.mutedForeground)
            }
            Button {
                let on = !inList
                inList = on
                Task { try? await model.media?.setWatchlist(kind: kind, tmdbId: tmdbId, on: on); await model.homeStore?.invalidate() }
            } label: {
                Label(inList ? "title.remove_list" : "title.add_list", systemImage: inList ? "checkmark" : "plus")
            }
        }
    }

    @ViewBuilder
    private func seasons(_ t: TitleDetails) -> some View {
        let list = (t.seasons ?? []).filter { $0.seasonNumber > 0 }
        VStack(alignment: .leading, spacing: 24) {
            if !list.isEmpty {
                ScrollView(.horizontal) {
                    HStack(spacing: 20) {
                        ForEach(list, id: \.seasonNumber) { s in
                            Button { Task { await loadSeason(s.seasonNumber) } } label: {
                                if season == s.seasonNumber {
                                    Label(String(localized: "title.season \(s.seasonNumber)"), systemImage: "checkmark")
                                } else {
                                    Text(String(localized: "title.season \(s.seasonNumber)"))
                                }
                            }
                        }
                    }
                    .padding(.vertical, 20)
                }
                .scrollClipDisabled()
            }
            if let sd = seasonData {
                ScrollView(.horizontal) {
                    LazyHStack(alignment: .top, spacing: 40) {
                        ForEach(sd.episodes, id: \.episodeNumber) { ep in episodeCard(ep, show: t) }
                    }
                    .padding(.vertical, 30)
                }
                .scrollClipDisabled()
            } else {
                ProgressView()
            }
        }
    }

    private func episodeCard(_ ep: SeasonEpisode, show: TitleDetails) -> some View {
        let t = PlayResolver.episode(tmdbId: tmdbId, season: ep.seasonNumber, episode: ep.episodeNumber, files: ep.files, progress: ep.progress)
        return VStack(alignment: .leading, spacing: 12) {
            Button {
                if let t { model.play(t, title: show.title, subtitle: "S\(ep.seasonNumber) E\(ep.episodeNumber) · \(ep.name)") }
            } label: {
                TVRemoteImage(url: model.client?.tmdbImageURL(size: TmdbSize.backdrop(780), path: ep.stillPath), aspect: 16 / 9)
                    .frame(width: 420)
                    .overlay(alignment: .bottom) {
                        if let p = ep.progress, p.durationSec > 0, !p.completed {
                            GeometryReader { g in Capsule().fill(TVTheme.primary).frame(width: g.size.width * min(1, p.positionSec / p.durationSec), height: 6) }
                                .frame(height: 6).padding(10)
                        }
                    }
            }
            .buttonStyle(.card)
            .disabled(t == nil)
            Text("\(ep.episodeNumber). \(ep.name)").font(TVTheme.body(24, weight: .semibold)).lineLimit(1).frame(width: 420, alignment: .leading)
            if t == nil { Text("title.not_in_library").font(TVTheme.body(20)).foregroundStyle(TVTheme.mutedForeground) }
            if ep.progress?.completed == true { Label("title.watched", systemImage: "checkmark.circle.fill").font(TVTheme.body(20)).foregroundStyle(TVTheme.success) }
        }
    }

    @ViewBuilder
    private func cast(_ t: TitleDetails) -> some View {
        if !t.cast.isEmpty {
            VStack(alignment: .leading, spacing: 20) {
                Text("title.cast").font(TVTheme.heading(36))
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 30) {
                        ForEach(t.cast.prefix(20), id: \.id) { p in
                            VStack(spacing: 10) {
                                TVRemoteImage(url: model.client?.tmdbImageURL(size: "w185", path: p.profilePath), aspect: 1).frame(width: 150).clipShape(.circle)
                                Text(p.name).font(TVTheme.body(22, weight: .medium)).lineLimit(1)
                                Text(p.role).font(TVTheme.body(20)).foregroundStyle(TVTheme.mutedForeground).lineLimit(1)
                            }
                            .frame(width: 180)
                            .focusable()
                            .accessibilityElement(children: .combine)
                        }
                    }
                    .padding(.vertical, 20)
                }
                .scrollClipDisabled()
            }
        }
    }

    @ViewBuilder
    private func related(_ t: TitleDetails) -> some View {
        let more = tvUniqueCards(t.recommendations + t.similar)
        if !more.isEmpty {
            VStack(alignment: .leading, spacing: 20) {
                Text("title.more_like").font(TVTheme.heading(36))
                ScrollView(.horizontal) {
                    LazyHStack(spacing: 40) { ForEach(more.prefix(20), id: \.self) { c in TVPosterCard(card: c, width: 220) } }
                        .padding(.vertical, 30)
                }
                .scrollClipDisabled()
            }
        }
    }
}
