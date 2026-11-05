import MixaiCore
import SwiftUI

/// Live TV: first-use legal notice, channel list with now/next, favourites, plays via the StreamResolver port.
struct LiveView: View {
    @Environment(AppModel.self) private var app
    @State private var channels: [LiveTvChannel] = []
    @State private var now: [String: LiveTvNowNext] = [:]
    @State private var accepted = Prefs.liveNoticeAccepted
    @State private var loaded = false
    @State private var error: String?
    @State private var favouritesOnly = false

    var body: some View {
        Group {
            if !accepted {
                notice
            } else if !loaded {
                StateView(kind: .loading)
            } else if let error {
                StateView(kind: .error(error)) { Task { await load() } }
            } else if channels.isEmpty {
                StateView(kind: .empty("live.empty", "live.empty_hint"))
            } else {
                list
            }
        }
        .background(Theme.background)
        .navigationTitle("tab.live")
        .toolbar { ProfileToolbar() }
        .task(id: accepted) { if accepted { await load() } }
    }

    private var notice: some View {
        VStack(spacing: 18) {
            Image(systemName: "dot.radiowaves.left.and.right").font(.system(size: 48)).foregroundStyle(Theme.primary)
            Text("live.notice_title").font(Theme.heading(24)).multilineTextAlignment(.center)
            Text("live.notice_body").font(Theme.body(15)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
            Button("live.notice_accept") { Prefs.liveNoticeAccepted = true; accepted = true }.buttonStyle(.glassProminent).controlSize(.large)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        let shown = favouritesOnly ? channels.filter(\.favourite) : channels
        return List {
            Toggle("live.favourites_only", isOn: $favouritesOnly)
            ForEach(shown, id: \.id) { c in
                Button { play(c) } label: {
                    HStack(spacing: 12) {
                        RemoteImage(url: c.logo.flatMap(URL.init(string:)), aspect: 1, contentMode: .fit).frame(width: 44).background(Theme.card, in: .rect(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                if let n = c.number { Text(n).font(Theme.body(12, weight: .semibold)).foregroundStyle(Theme.mutedForeground) }
                                Text(c.name).font(Theme.body(15, weight: .semibold)).lineLimit(1)
                            }
                            if let p = now[c.id]?.now { Text(p.title).font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1) }
                        }
                        Spacer()
                        if c.favourite { Image(systemName: "star.fill").foregroundStyle(Tokens.Dark.warning).accessibilityLabel(Text("live.favourite")) }
                    }
                }
                .swipeActions {
                    Button(c.favourite ? "live.unfavourite" : "live.favourite") { Task { try? await app.liveTv?.setFavourite(c.id, !c.favourite); await load() } }
                        .tint(Tokens.Dark.warning)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .refreshable { await load() }
    }

    private func load() async {
        guard let live = app.liveTv else { return }
        error = nil
        do {
            channels = try await live.channels().filter { !$0.hidden }
            if let nn = try? await live.nowNext() { now = Dictionary(nn.map { ($0.channelId, $0) }, uniquingKeysWith: { a, _ in a }) }
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func play(_ c: LiveTvChannel) {
        app.player.start(PlayRequest(source: .live(channelId: c.id, name: c.name), title: c.name, subtitle: now[c.id]?.now?.title, artwork: nil), app: app)
    }
}
