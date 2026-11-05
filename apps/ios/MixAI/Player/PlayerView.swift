import AVKit
import MixaiCore
import SwiftUI
import UIKit

/// Full-screen player: AVPlayerLayer surface + SwiftUI OSD (scrubber, skip, tracks, speed, sleep, AirPlay, PiP).
struct PlayerView: View {
    @Environment(AppModel.self) private var app
    @State private var osd = true
    @State private var scrubbing: Double?
    @State private var pip = PiPController()
    @State private var hideTask: Task<Void, Never>?
    @State private var showSubSearch = false
    @State private var showBookmarks = false

    private var player: PlayerCoordinator { app.player }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            Group {
                if player.usingVLC {
                    VLCSurface(player: player, generation: player.engineGeneration)
                } else {
                    VideoSurface(player: player.avPlayer, pip: pip)
                }
            }
            .ignoresSafeArea()
            .onTapGesture { toggleOSD() }
            .accessibilityLabel(Text("player.surface"))
            .accessibilityAddTraits(.isButton)
            if player.activeCue != nil || player.secondaryCue != nil {
                VStack(spacing: 6) {
                    Spacer()
                    if let second = player.secondaryCue {
                        Text(second)
                            .font(Theme.body(15, weight: .medium))
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.white.opacity(0.78))
                            .padding(.horizontal, 10).padding(.vertical, 4)
                            .background(.black.opacity(0.5), in: .rect(cornerRadius: 6))
                    }
                    if let cue = player.activeCue {
                        Text(cue)
                            .font(Theme.body(20, weight: .semibold))
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(.black.opacity(0.6), in: .rect(cornerRadius: 8))
                    }
                }
                .padding(.bottom, osd ? 130 : 40)
                .allowsHitTesting(false)
            }
            if player.buffering && player.error == nil && !player.capLocked && !player.askDataSaver {
                ProgressView().controlSize(.large).tint(.white)
            }
            if player.capLocked {
                Color.black.opacity(0.85).ignoresSafeArea()
                CapLockedView(minutes: player.capMinutes) { player.dismiss() }
            } else if let err = player.error {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill").font(.largeTitle).foregroundStyle(Theme.destructive)
                    Text("player.error.title").font(Theme.heading(20))
                    Text(err).font(Theme.body(14)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
                    Button("action.close") { player.dismiss() }.buttonStyle(.glassProminent)
                }
                .padding(24)
            }
            if osd { overlay.transition(.opacity) }
            if player.showSkipIntro {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button("player.skip_intro") { player.skipIntro() }
                            .buttonStyle(.glassProminent)
                            .padding(.trailing, 24).padding(.bottom, osd ? 140 : 48)
                    }
                }
            }
        }
        .statusBarHidden(!osd)
        .persistentSystemOverlays(osd ? .automatic : .hidden)
        .onAppear { pip.attach(player.avPlayer); scheduleHide() }
        .onChange(of: player.request?.id) { pip.attach(player.avPlayer) }
        .onChange(of: player.avPlayer) { pip.attach(player.avPlayer) }
        .alert(Text("datasaver.title"), isPresented: Binding(get: { player.askDataSaver }, set: { if !$0 { player.askDataSaver = false } })) {
            Button("datasaver.play_anyway") { player.confirmDataSaver() }
            Button("action.close", role: .cancel) { player.dismiss() }
        } message: {
            Text("datasaver.body")
        }
        .sheet(isPresented: $showSubSearch) { SubtitleSearchSheet(player: player) }
        .sheet(isPresented: $showBookmarks) { BookmarksSheet(player: player) }
    }

    private func toggleOSD() {
        withAnimation(.easeOut(duration: 0.2)) { osd.toggle() }
        if osd { scheduleHide() }
    }

    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled && player.playing && scrubbing == nil { withAnimation { osd = false } }
        }
    }

    private var overlay: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { player.dismiss() } label: { Image(systemName: "chevron.down").font(.title3.weight(.semibold)) }
                    .accessibilityLabel(Text("action.close"))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(player.request?.title ?? "").font(Theme.heading(17)).lineLimit(1)
                        if player.usingVLC { badge(Text(verbatim: player.engineName)) }
                        if player.isOffline { badge(Text("player.offline_badge")) }
                    }
                    if let s = player.request?.subtitle { Text(s).font(Theme.body(13)).foregroundStyle(.white.opacity(0.75)).lineLimit(1) }
                }
                Spacer()
                if player.isFile { PlayOnTVButton(player: player) }
                if !player.usingVLC {
                    RoutePicker().frame(width: 32, height: 32).accessibilityLabel(Text("player.airplay"))
                }
                if pip.possible && !player.usingVLC {
                    Button { pip.toggle() } label: { Image(systemName: "pip.enter") }.accessibilityLabel(Text("player.pip"))
                }
                menu
            }
            .padding(.horizontal, 20).padding(.top, 12)
            Spacer()
            HStack(spacing: 48) {
                Button { player.skip(-10) } label: { Image(systemName: "gobackward.10").font(.system(size: 30)) }
                    .accessibilityLabel(Text("player.back10"))
                Button { player.togglePlay(); scheduleHide() } label: {
                    Image(systemName: player.playing ? "pause.fill" : "play.fill").font(.system(size: 44))
                }
                .accessibilityLabel(Text(player.playing ? "player.pause" : "player.play"))
                Button { player.skip(30) } label: { Image(systemName: "goforward.30").font(.system(size: 30)) }
                    .accessibilityLabel(Text("player.fwd30"))
            }
            Spacer()
            if case .file = player.request?.source { scrubber.padding(.horizontal, 20).padding(.bottom, 16) }
        }
        .foregroundStyle(.white)
        .background(LinearGradient(colors: [.black.opacity(0.65), .clear, .clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
    }

    private var scrubber: some View {
        VStack(spacing: 6) {
            Slider(value: Binding(get: { scrubbing ?? player.position }, set: { scrubbing = $0 }),
                   in: 0...max(1, player.duration)) { editing in
                if !editing, let v = scrubbing { player.seek(to: v); scrubbing = nil; scheduleHide() }
            }
            .accessibilityLabel(Text("player.position"))
            HStack {
                Text(formatClock(scrubbing ?? player.position)).monospacedDigit()
                Spacer()
                Text("-" + formatClock(max(0, player.duration - (scrubbing ?? player.position)))).monospacedDigit()
            }
            .font(Theme.body(12)).foregroundStyle(.white.opacity(0.8))
        }
    }

    private var menu: some View {
        Menu {
            if !player.audioTracks.isEmpty && player.canSwitchAudio {
                Picker(selection: Binding(get: { player.audioOrdinal }, set: { player.selectAudio($0) })) {
                    ForEach(Array(player.audioTracks.enumerated()), id: \.offset) { i, t in
                        Text(audioLabel(lang: t.lang, codec: t.codec, channels: t.channels, title: t.title)).tag(i)
                    }
                } label: { Label("player.audio", systemImage: "waveform") }
                .pickerStyle(.menu)
            }
            Picker(selection: Binding(get: { player.subtitleOrdinal ?? -1 }, set: { player.selectSubtitle($0 < 0 ? nil : $0) })) {
                Text("player.subtitles_off").tag(-1)
                ForEach(player.subtitleTracks, id: \.ordinal) { s in
                    Text(s.track.title ?? s.track.lang?.uppercased() ?? String(localized: "player.subtitle_n \(s.ordinal + 1)")).tag(s.ordinal)
                }
            } label: { Label("player.subtitles", systemImage: "captions.bubble") }
            .pickerStyle(.menu)
            if !player.subtitleTracks.isEmpty { SecondarySubtitlePicker(player: player) }
            if player.isFile {
                Button { showSubSearch = true } label: { Label("player.search_subs", systemImage: "text.magnifyingglass") }
                Button { showBookmarks = true } label: { Label("player.bookmarks", systemImage: "bookmark") }
            }
            Toggle(isOn: Binding(get: { player.nightMode }, set: { player.setNightMode($0) })) {
                Label(player.nightModeAvailable ? LocalizedStringKey("player.night_mode") : LocalizedStringKey("player.night_mode_unavailable"), systemImage: "moon.stars")
            }
            .disabled(!player.nightModeAvailable)
            Picker(selection: Binding(get: { player.speed }, set: { player.setSpeed($0) })) {
                ForEach([Float(0.5), 0.75, 1, 1.25, 1.5, 2], id: \.self) { Text(String(format: "%.2g×", $0)).tag($0) }
            } label: { Label("player.speed", systemImage: "speedometer") }
            .pickerStyle(.menu)
            Menu {
                Button("player.sleep_off") { player.setSleep(minutes: nil) }
                ForEach([15, 30, 45, 60, 90], id: \.self) { m in Button("player.sleep_min \(m)") { player.setSleep(minutes: m) } }
                if case .file = player.request?.source {
                    Button("player.sleep_end") { player.setSleepEndOfItem() }
                }
            } label: { Label("player.sleep", systemImage: "moon.zzz") }
            if player.isFile {
                Button { player.playOnTV() } label: { Label("player.play_on", systemImage: "airplayvideo") }
            }
        } label: {
            Image(systemName: "ellipsis.circle").font(.title3)
        }
        .accessibilityLabel(Text("player.options"))
    }

    private func badge(_ text: Text) -> some View {
        text
            .font(Theme.body(10, weight: .bold))
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(.white.opacity(0.2), in: .rect(cornerRadius: 4))
    }
}

/// UIView hosting an AVPlayerLayer (PiP needs the layer).
struct VideoSurface: UIViewRepresentable {
    let player: AVPlayer?
    let pip: PiPController

    final class LayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }

    func makeUIView(context: Context) -> LayerView {
        let v = LayerView()
        v.playerLayer.videoGravity = .resizeAspect
        v.playerLayer.player = player
        pip.setLayer(v.playerLayer)
        return v
    }

    func updateUIView(_ v: LayerView, context: Context) {
        if v.playerLayer.player !== player { v.playerLayer.player = player }
    }
}

/// AirPlay route button.
struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.tintColor = .white
        v.prioritizesVideoDevices = true
        return v
    }
    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

/// Picture in Picture, starts automatically when the app goes to the background while playing.
@MainActor
@Observable
final class PiPController: NSObject, AVPictureInPictureControllerDelegate {
    private var controller: AVPictureInPictureController?
    private weak var layer: AVPlayerLayer?
    var possible = false

    func setLayer(_ l: AVPlayerLayer) {
        layer = l
        guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
        let c = AVPictureInPictureController(playerLayer: l)
        c?.canStartPictureInPictureAutomaticallyFromInline = true
        c?.delegate = self
        controller = c
        possible = c != nil
    }

    func attach(_ player: AVPlayer?) {
        layer?.player = player
    }

    func toggle() {
        guard let c = controller else { return }
        if c.isPictureInPictureActive { c.stopPictureInPicture() } else { c.startPictureInPicture() }
    }
}
