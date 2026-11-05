import MixaiCore
import SwiftUI

/// Offline library: storage gauge, groups by show/season, per-item progress, settings.
struct DownloadsView: View {
    @Environment(AppModel.self) private var app
    @State private var confirmDeleteAll = false
    @State private var free: Int64 = OfflineStore.freeBytes()

    var body: some View {
        @Bindable var store = app.offline
        let groups = OfflineLibrary.group(store.items)
        let gauge = OfflineLibrary.gauge(items: store.items, freeBytes: free)
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    ProgressView(value: gauge.fraction).tint(Theme.primary)
                    Text("downloads.storage \(Self.bytes(gauge.used)) \(Self.bytes(gauge.free))")
                        .font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                }
                .accessibilityElement(children: .combine)
                Toggle("downloads.wifi_only_toggle", isOn: $store.wifiOnly)
                Toggle("downloads.smart", isOn: $store.smartEnabled)
                Toggle("downloads.auto_delete", isOn: $store.autoDeleteWatched)
            } footer: { Text("downloads.settings_footer") }

            if groups.isEmpty {
                Section {
                    StateView(kind: .empty("downloads.empty", "downloads.empty_hint")).frame(minHeight: 260)
                }
                .listRowBackground(Color.clear)
            }
            ForEach(groups) { g in
                Section {
                    ForEach(g.seasons) { s in
                        if g.isShow && s.number > 0 {
                            Text("title.season \(s.number)").font(Theme.body(12, weight: .semibold)).foregroundStyle(Theme.mutedForeground)
                        }
                        ForEach(s.items) { item in
                            row(item)
                                .swipeActions {
                                    Button("action.delete", role: .destructive) { store.delete(item.id) }
                                }
                        }
                    }
                } header: {
                    HStack(spacing: 10) {
                        RemoteImage(url: app.client?.tmdbImageURL(size: "w92", path: g.posterPath)).frame(width: 28).clipShape(.rect(cornerRadius: 4))
                        Text(g.title).font(Theme.body(14, weight: .semibold))
                        Spacer()
                        Text(Self.bytes(g.bytes)).font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                    }
                }
            }
            if !groups.isEmpty {
                Section {
                    Button("downloads.delete_all", role: .destructive) { confirmDeleteAll = true }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("downloads.title")
        .confirmationDialog("downloads.delete_all_confirm", isPresented: $confirmDeleteAll, titleVisibility: .visible) {
            Button("downloads.delete_all", role: .destructive) { store.deleteAll(); free = OfflineStore.freeBytes() }
        }
        .onChange(of: store.items.count) { free = OfflineStore.freeBytes() }
    }

    @ViewBuilder
    private func row(_ item: DownloadItem) -> some View {
        Button { play(item) } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title).font(Theme.body(15, weight: .semibold)).lineLimit(2)
                    switch item.state {
                    case .done:
                        HStack(spacing: 6) {
                            Text(Self.bytes(item.bytesTotal))
                            if item.watchedAt != nil { Label("title.watched", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.success) }
                            if item.smart { Text("downloads.smart_badge") }
                        }
                        .font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                    case .queued:
                        Text("downloads.state.queued").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                    case .preparing:
                        ProgressView(value: item.progress).tint(Theme.primary)
                        Text("downloads.state.preparing \(Int(item.progress * 100))").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                    case .downloading:
                        ProgressView(value: item.progress).tint(Theme.primary)
                        Text("downloads.state.downloading \(Self.bytes(item.bytesDone)) \(Self.bytes(item.bytesTotal))").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                    case .paused:
                        Text(item.error ?? String(localized: "downloads.waiting_wifi")).font(Theme.body(12)).foregroundStyle(Tokens.Dark.warning)
                    case .failed:
                        Text("downloads.state.failed \(item.error ?? "")").font(Theme.body(12)).foregroundStyle(Theme.destructive).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                switch item.state {
                case .done: Image(systemName: "play.circle.fill").font(.title2).foregroundStyle(Theme.primary)
                case .failed:
                    Button { app.offline.retry(item.id) } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(Text("action.retry"))
                default: EmptyView()
                }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
    }

    private func play(_ item: DownloadItem) {
        guard item.state == .done else { return }
        app.player.start(PlayRequest(source: .file(fileId: item.fileId, ref: item.ref, startSec: item.positionSec ?? 0),
                                     title: item.show ?? item.title, subtitle: item.show == nil ? nil : item.title, artwork: nil), app: app)
    }

    static func bytes(_ b: Int64) -> String { ByteCountFormatter.string(fromByteCount: b, countStyle: .file) }
}

/// Download control used by Title (movie action + episode rows): enqueue or show state.
struct DownloadButton: View {
    @Environment(AppModel.self) private var app
    let fileId: String
    let ref: MediaRef?
    let title: String
    let show: String?
    let posterPath: String?
    var compact = false
    @State private var wifiAlert = false

    var body: some View {
        let item = app.offline.item(fileId: fileId)
        Button {
            if item?.state == .done || item?.state == .downloading || item?.state == .preparing {
                app.pendingRoute = .downloads
                return
            }
            if dataSaverDecision(expensive: app.networkExpensive, saverOn: app.dataSaver, acknowledged: false, isDownload: true) == .blockDownload {
                wifiAlert = true
                return
            }
            if app.offline.enqueue(fileId: fileId, audio: 0, ref: ref, title: title, show: show, posterPath: posterPath, smart: false) == .waitingForWifi {
                wifiAlert = true
            }
        } label: {
            Image(systemName: icon(item?.state)).frame(width: 28, height: 28)
        }
        .accessibilityLabel(Text(label(item?.state)))
        .alert("downloads.wifi_only", isPresented: $wifiAlert) {
            Button("action.ok", role: .cancel) {}
        } message: { Text("downloads.wifi_only_body") }
    }

    private func icon(_ s: DownloadItem.State?) -> String {
        switch s {
        case .done: "arrow.down.circle.fill"
        case .downloading, .preparing, .queued: "arrow.down.circle.dotted"
        case .paused: "pause.circle"
        case .failed: "exclamationmark.arrow.circlepath"
        case nil: "arrow.down.circle"
        }
    }

    private func label(_ s: DownloadItem.State?) -> LocalizedStringKey {
        switch s {
        case .done: "downloads.downloaded"
        case .downloading, .preparing, .queued: "downloads.in_progress"
        default: "downloads.download"
        }
    }
}
