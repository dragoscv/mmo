import MixaiCore
import MixaiUI
import MusicKit
import SwiftUI

/// Set log tab: entries newest first, export (text / CSV / M3U8 / rekordbox XML / Apple Music playlist), clear.
struct SetLogView: View {
    @Environment(ListenSession.self) private var s
    @State private var share: ShareItem?
    @State private var confirmClear = false
    @State private var playlistResult: LocalizedStringKey?

    var body: some View {
        let entries = s.log.entries
        NavigationStack {
            Group {
                if entries.isEmpty {
                    ContentUnavailableView { Label("kb.tab.setlog", systemImage: "list.bullet.rectangle") } description: { Text("kb.history.empty") }
                } else {
                    List {
                        ForEach(entries) { e in row(e) }
                            .onDelete { idx in idx.map { entries[$0].at }.forEach(s.log.remove) }
                    }
                    .scrollContentBackground(.hidden)
                }
            }
            .background(KB.bg)
            .navigationTitle("kb.tab.setlog")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("kb.export.text") { export(.text) }
                        Button("kb.export.csv") { export(.csv) }
                        Button("kb.export.m3u8") { export(.m3u8) }
                        Button("kb.export.rekordbox") { export(.rekordbox) }
                        Button("kb.export.apple_music") { Task { await applePlaylist() } }
                    } label: { Label("kb.history.export", systemImage: "square.and.arrow.up") }
                    .disabled(entries.isEmpty)
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button("kb.history.clear", role: .destructive) { confirmClear = true }.disabled(entries.isEmpty)
                }
            }
            .confirmationDialog("kb.history.clear_confirm", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("kb.history.clear", role: .destructive) { s.log.clear() }
            }
            .alert(playlistResult ?? "", isPresented: Binding(get: { playlistResult != nil }, set: { if !$0 { playlistResult = nil } })) {
                Button("kb.ok") {}
            }
            .shareSheet($share)
        }
    }

    private func row(_ e: LogEntry) -> some View {
        HStack(spacing: 12) {
            Circle().fill(e.keyIndex.map(KB.keyColor) ?? KB.muted).frame(width: 14, height: 14)
            VStack(alignment: .leading, spacing: 2) {
                if e.source == .mic, let t = e.title {
                    Text(e.artist.map { "\($0) \u{2013} \(t)" } ?? t).font(Theme.body(15, weight: .semibold))
                }
                Text("\(e.keyIndex.map { s.notation.label($0) } ?? e.camelot)  \u{00B7}  \(String(format: "%.1f", e.bpm)) BPM")
                    .font(Theme.body(15, weight: e.title == nil || e.source != .mic ? .semibold : .regular))
                Text(meta(e)).font(Theme.body(12)).foregroundStyle(KB.muted)
            }
        }
        .listRowBackground(Color.clear)
    }

    private func meta(_ e: LogEntry) -> String {
        var parts: [String] = []
        if e.source == .file, let t = e.title { parts.append(t) }
        parts.append(e.keyName)
        if e.libraryTrackId != nil { parts.append(String(localized: "kb.songid.in_library")) }
        parts.append(e.at.formatted(date: .abbreviated, time: .shortened))
        return parts.joined(separator: " \u{00B7} ")
    }

    private enum Format { case text, csv, m3u8, rekordbox }

    private func export(_ f: Format) {
        let entries = s.log.entries
        let day = Date.now.formatted(.iso8601.year().month().day())
        let title = "\(String(localized: "kb.export.title")) \(day)"
        let (name, body): (String, String) = switch f {
        case .text: ("mixai-tracklist-\(day).txt", SetExport.text(entries))
        case .csv: ("mixai-setlog-\(day).csv", SetExport.csv(entries))
        case .m3u8: ("mixai-setlog-\(day).m3u8", SetExport.m3u8(entries))
        case .rekordbox: ("mixai-setlog-\(day).xml", SetExport.rekordbox(entries, playlist: title))
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do { try body.write(to: url, atomically: true, encoding: .utf8); share = ShareItem(url: url) } catch {}
    }

    /// Set log → Apple Music playlist (MusicKit): matched tracks (Apple Music id or ISRC) in set order.
    private func applePlaylist() async {
        guard await MusicAuthorization.request() == .authorized else { playlistResult = "kb.export.apple_music_denied"; return }
        var songs: [Song] = []
        for e in s.log.entries.reversed() {
            if let id = e.appleMusicId, let r = try? await MusicCatalogResourceRequest<Song>(matching: \.id, equalTo: MusicItemID(id)).response(), let song = r.items.first {
                songs.append(song)
            } else if let isrc = e.isrc, let r = try? await MusicCatalogResourceRequest<Song>(matching: \.isrc, equalTo: isrc).response(), let song = r.items.first {
                songs.append(song)
            }
        }
        guard !songs.isEmpty else { playlistResult = "kb.export.apple_music_none"; return }
        let name = "\(String(localized: "kb.export.title")) \(Date.now.formatted(date: .abbreviated, time: .omitted))"
        do {
            _ = try await MusicLibrary.shared.createPlaylist(name: name, description: "MixAI Key & BPM", items: songs)
            playlistResult = "kb.export.apple_music_done \(songs.count)"
        } catch {
            playlistResult = "kb.export.apple_music_failed"
        }
    }
}

/// Library tab: MMO Server connect + tracks that mix with the live / last key and BPM.
struct LibraryView: View {
    @Environment(ListenSession.self) private var s
    @State private var lib = LibraryClient.shared
    @State private var tracks: [LibraryClient.Track] = []
    @State private var loading = false
    @State private var error: String?
    @State private var connecting = false
    @Environment(\.openURL) private var openURL

    private var camelot: String? { s.reading?.keyIndex.map(Harmony.camelot) ?? s.log.entries.first?.camelot }
    private var bpm: Double? { s.bpm ?? s.log.entries.first?.bpm }

    var body: some View {
        NavigationStack {
            List {
                if !lib.connected {
                    Section {
                        Text("kb.library.intro").foregroundStyle(KB.muted)
                        Button("kb.library.connect") { connecting = true }.buttonStyle(.glassProminent)
                    }
                } else {
                    Section {
                        HStack {
                            Text(lib.serverName ?? lib.baseURL ?? "").lineLimit(1)
                            Spacer()
                            Button("kb.library.disconnect", role: .destructive) { lib.disconnect(); tracks = [] }
                        }
                    }
                    results
                }
            }
            .scrollContentBackground(.hidden)
            .background(KB.bg)
            .navigationTitle("kb.tab.library")
            .task(id: "\(lib.connected)-\(camelot ?? "")-\(Int((bpm ?? 0).rounded()))") { await load() }
            .sheet(isPresented: $connecting) { ConnectSheet() }
        }
    }

    @ViewBuilder private var results: some View {
        if camelot == nil, bpm == nil {
            Text("kb.library.need_reading").foregroundStyle(KB.muted)
        } else {
            Section {
                if loading { ProgressView() }
                else if let error { Text("kb.library.error \(error)").foregroundStyle(KB.error) }
                else if tracks.isEmpty { Text("kb.library.empty").foregroundStyle(KB.muted) }
                ForEach(tracks) { t in
                    Button { if let u = LibraryClient.playURL(trackId: t.id) { openURL(u) } } label: { row(t) }
                        .listRowBackground(Color.clear)
                }
            } header: {
                let head = [camelot.flatMap(Harmony.fromCamelot).map { s.notation.label($0) } ?? camelot, bpm.map { String(format: "%.1f BPM", $0) }]
                    .compactMap { $0 }.joined(separator: " \u{00B7} ")
                Text("kb.library.for \(head)")
            }
        }
    }

    private func row(_ t: LibraryClient.Track) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(t.title).font(Theme.body(15, weight: .semibold)).lineLimit(1).foregroundStyle(KB.fg)
                if let a = t.artist { Text(a).font(Theme.body(13)).foregroundStyle(KB.muted) }
                if let adv = advice(t) { Text(adv).font(Theme.body(12)).foregroundStyle(KB.primary) }
            }
            Spacer()
            VStack(alignment: .trailing) {
                Text([t.keyCamelot.flatMap(Harmony.fromCamelot).map { s.notation.label($0) }, t.bpm.map { String(format: "%.0f", $0) }]
                    .compactMap { $0 }.joined(separator: " \u{00B7} ")).font(Theme.body(13)).foregroundStyle(KB.fg)
                if let sc = t.score { Text("\(Int((sc * 100).rounded()))%").font(Theme.body(12)).foregroundStyle(KB.success) }
            }
        }
    }

    private func advice(_ t: LibraryClient.Track) -> String? {
        guard let lk = camelot.flatMap(Harmony.fromCamelot), let tk = t.keyCamelot.flatMap(Harmony.fromCamelot), let lb = bpm, let tb = t.bpm else { return nil }
        let a = Harmony.mixAdvice(liveKey: lk, liveBpm: lb, trackKey: tk, trackBpm: tb)
        let rate = String(format: "%+.1f %%", a.ratePercent)
        if let at = a.keyAtRate { return String(localized: "kb.advice.lands \(rate) \(s.notation.label(at))") }
        if a.transpose != 0 { return String(localized: "kb.advice.transpose \(rate) \(String(format: "%+d", a.transpose)) \(s.notation.label(a.keyAfter))") }
        return String(localized: "kb.advice.rate \(rate)")
    }

    private func load() async {
        guard lib.connected, camelot != nil || bpm != nil else { tracks = []; return }
        loading = true; error = nil
        defer { loading = false }
        do { tracks = try await lib.compatible(camelot: camelot, bpm: bpm) } catch { self.error = error.localizedDescription }
    }
}

/// Server list → Quick Connect (shared MixaiUI views).
private struct ConnectSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var path: [DiscoveredServer] = []

    var body: some View {
        NavigationStack(path: $path) {
            ServerListView { path.append($0) }
                .navigationDestination(for: DiscoveredServer.self) { server in
                    PairView(server: server) { token in
                        LibraryClient.shared.connect(name: server.name, baseURL: server.baseURL, token: token)
                        dismiss()
                    }
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("kb.cancel") { dismiss() } } }
        }
    }
}
