import MixaiCore
import SwiftUI

// Google Cast is intentionally not on iOS: AirPlay (system route picker) + "Play on TV" through the MMO Server hub
// cover every MixAI TV and Apple TV without the Cast SDK (tracker D37 note).

/// "Play on…" sheet: AirPlay route picker, then hub playback targets (TVs, other phones with `playback`).
struct PlayOnSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let request: PlayRequest?
    @State private var sending: String?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        RoutePicker().frame(width: 32, height: 32).accessibilityLabel(Text("player.airplay"))
                        Text("playon.airplay").font(Theme.body(15))
                    }
                }
                Section {
                    if app.playbackTargets.isEmpty {
                        Text("playon.none").font(Theme.body(14)).foregroundStyle(Theme.mutedForeground)
                    }
                    ForEach(app.playbackTargets, id: \.deviceId) { d in
                        VStack(alignment: .leading, spacing: 8) {
                            Button { Task { await send(to: d) } } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: d.formFactor == .phone ? "iphone" : "tv").foregroundStyle(Theme.primary)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(d.name).font(Theme.body(15, weight: .semibold))
                                        if let t = d.nowPlaying?.media?.title {
                                            Text("playon.now \(t)").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    if sending == d.deviceId { ProgressView() }
                                }
                            }
                            .disabled(request == nil || sending != nil)
                            if let np = d.nowPlaying, np.media?.fileId != nil {
                                Button { Task { await pullBack(from: d, np) } } label: {
                                    Label("playon.continue_here", systemImage: "arrow.down.forward.and.arrow.up.backward")
                                }
                                .font(Theme.body(13))
                                .buttonStyle(.borderless)
                            }
                        }
                    }
                } header: { Text("playon.devices") } footer: {
                    if let error { Text(error).foregroundStyle(Theme.destructive) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.background)
            .navigationTitle("playon.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("action.close") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func send(to d: HubDevice) async {
        guard let req = request, case .file(let fid, let ref, let start) = req.source, let phone = app.phone else {
            error = String(localized: "playon.only_files")
            return
        }
        sending = d.deviceId
        error = nil
        defer { sending = nil }
        var args: [String: JSONValue] = ["fileId": .string(fid), "startSec": .number(start), "title": .string(req.title)]
        if let ref {
            args["kind"] = .string(ref.kind.rawValue)
            args["tmdbId"] = .number(Double(ref.tmdbId))
            if let s = ref.season { args["season"] = .number(Double(s)) }
            if let e = ref.episode { args["episode"] = .number(Double(e)) }
        }
        do {
            let ack = try await phone.command(target: d.deviceId, action: "play", args: args)
            if ack.ok {
                app.player.stop()
                app.toast = String(localized: "playon.continuing \(d.name)")
                app.playOnRequest = nil
                dismiss()
            } else {
                error = ack.error ?? String(localized: "playon.failed")
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// Stop on the TV and continue locally where it was.
    private func pullBack(from d: HubDevice, _ np: HubNowPlaying) async {
        guard let m = np.media, let fid = m.fileId, let phone = app.phone else { return }
        let pos = AppModel.livePosition(np)
        _ = try? await phone.command(target: d.deviceId, action: "stop")
        var ref: MediaRef?
        if let k = m.kind.flatMap(MediaKind.init(rawValue:)), let id = m.tmdbId { ref = MediaRef(kind: k, tmdbId: id, season: m.season, episode: m.episode) }
        dismiss()
        app.player.start(PlayRequest(source: .file(fileId: fid, ref: ref, startSec: pos), title: m.title ?? "MixAI TV", subtitle: nil, artwork: nil), app: app)
    }
}
