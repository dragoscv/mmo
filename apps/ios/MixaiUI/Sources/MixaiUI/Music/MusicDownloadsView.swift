import MixaiCore
import SwiftUI

/// Offline music: usage vs limit, play all, in-progress list, downloaded tracks (swipe to remove), remove all.
public struct MusicDownloadsView: View {
    @Environment(MusicEnvironment.self) private var env
    @State private var confirmAll = false

    public init() {}

    public var body: some View {
        if let dl = env.downloads {
            content(dl)
        } else {
            StateView(kind: .empty("downloads.empty", "downloads.empty_hint"), symbol: "arrow.down.circle")
        }
    }

    private func content(_ dl: MusicDownloads) -> some View {
        let done = dl.doneTracks
        return List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    let used = dl.usedBytes, limit = dl.limitBytes
                    ProgressView(value: limit > 0 ? min(1, Double(used) / Double(limit)) : 0)
                        .tint(used > limit && limit > 0 ? Theme.destructive : Theme.primary)
                    Text(limit > 0
                         ? String(localized: "music.dl.usage \(bytes(used)) \(bytes(limit))")
                         : String(localized: "music.dl.usage_unlimited \(bytes(used))"))
                        .font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                    if dl.waitingForWifi {
                        Label("downloads.waiting_wifi", systemImage: "wifi.slash").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                    }
                }
                .listRowBackground(Color.clear)
                if !done.isEmpty {
                    HStack(spacing: 12) {
                        Button { env.play(done, at: 0) } label: { Label("music.dl.play_all", systemImage: "play.fill") }.buttonStyle(.glassProminent)
                        Button { env.play(done, at: 0, shuffle: true) } label: { Label("music.shuffle", systemImage: "shuffle") }.buttonStyle(.glass)
                    }
                    .listRowBackground(Color.clear)
                }
            }
            if !dl.active.isEmpty {
                Section("downloads.in_progress") {
                    ForEach(dl.active) { d in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(d.track.title).font(Theme.body(14, weight: .medium)).lineLimit(1)
                                if let e = d.error { Text(e).font(Theme.body(11)).foregroundStyle(Theme.destructive).lineLimit(2) }
                            }
                            Spacer()
                            switch d.state {
                            case .downloading: ProgressView(value: d.progress).frame(width: 60)
                            case .failed:
                                Button("action.retry") { dl.download([d.track]) }.font(Theme.body(12))
                            default: DownloadBadge(state: d.state)
                            }
                        }
                        .listRowBackground(Color.clear)
                    }
                    .onDelete { idx in dl.remove(idx.map { dl.active[$0].id }) }
                }
            }
            Section {
                if done.isEmpty && dl.active.isEmpty {
                    StateView(kind: .empty("music.dl.empty", "music.dl.empty_hint"), symbol: "arrow.down.circle").listRowBackground(Color.clear)
                }
                ForEach(Array(done.enumerated()), id: \.element.id) { i, t in
                    TrackRow(track: t, list: done) { env.play(done, at: i) }
                        .listRowInsets(EdgeInsets()).listRowBackground(Color.clear)
                }
                .onDelete { idx in dl.remove(idx.map { done[$0].id }) }
            } header: {
                if !done.isEmpty { Text("music.dl.tracks_count \(done.count)") }
            }
            if !dl.items.isEmpty {
                Section {
                    Button("downloads.delete_all", role: .destructive) { confirmAll = true }
                }
                .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("downloads.title")
        .confirmationDialog("downloads.delete_all_confirm", isPresented: $confirmAll, titleVisibility: .visible) {
            Button("downloads.delete_all", role: .destructive) { dl.removeAll() }
        }
    }

    private func bytes(_ b: Int64) -> String { ByteCountFormatter.string(fromByteCount: b, countStyle: .file) }
}
