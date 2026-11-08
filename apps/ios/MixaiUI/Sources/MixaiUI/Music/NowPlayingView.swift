import AVKit
import MixaiCore
import SwiftUI

/// Full-screen now playing: cover / synced lyrics / queue, transport, shuffle + repeat, sleep timer, AirPlay route
/// picker and "Play on" (hub outputs).
public struct NowPlayingView: View {
    @Environment(MusicEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    enum Pane: String, CaseIterable { case cover, lyrics, queue }
    @State private var pane: Pane = .cover
    @State private var scrubbing: Double?
    @State private var showOutputs = false
    @State private var handoffError = false

    public init() {}

    public var body: some View {
        let m = env.player
        VStack(spacing: 16) {
            Capsule().fill(Theme.muted).frame(width: 40, height: 5).padding(.top, 8).accessibilityHidden(true)
            if let t = m.current {
                Group {
                    switch pane {
                    case .cover: cover(t)
                    case .lyrics: LyricsPane()
                    case .queue: QueuePane()
                    }
                }
                .frame(maxHeight: .infinity)
                VStack(spacing: 4) {
                    Text(t.title).font(Theme.heading(22)).lineLimit(1)
                    Text([t.artist, t.album].compactMap { $0 }.joined(separator: " — ")).font(Theme.body(14)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                }
                .padding(.horizontal, 24)
                scrubber(t)
                transport
                bottomBar
            } else {
                StateView(kind: .empty("music.nothing_playing", "music.nothing_playing_hint"), symbol: "music.note")
            }
        }
        .padding(.bottom, 12)
        .foregroundStyle(Theme.foreground)
        .background(background)
        .sheet(isPresented: $showOutputs) { OutputsSheet(handoffError: $handoffError).presentationDetents([.medium]) }
        .alert("music.handoff_failed", isPresented: $handoffError) { Button("action.ok", role: .cancel) {} }
    }

    private var background: some View {
        ZStack {
            Theme.background
            RemoteImage(url: env.cover(env.player.current?.coverUrlPath), aspect: 1, placeholderSymbol: "music.note")
                .blur(radius: 60).opacity(0.45).scaleEffect(1.4)
            Theme.background.opacity(0.35)
        }
        .ignoresSafeArea()
    }

    private func cover(_ t: TrackCard) -> some View {
        RemoteImage(url: env.cover(t.coverUrlPath), aspect: 1, placeholderSymbol: "music.note")
            .frame(maxWidth: 320).clipShape(.rect(cornerRadius: 20)).shadow(radius: 24)
            .padding(.horizontal, 32)
            .scaleEffect(env.player.playing ? 1 : 0.92)
            .animation(.smooth, value: env.player.playing)
    }

    private func scrubber(_ t: TrackCard) -> some View {
        let m = env.player
        let total = max(1, m.duration > 0 ? m.duration : t.durationSec)
        return VStack(spacing: 2) {
            Slider(value: Binding(get: { scrubbing ?? m.position }, set: { scrubbing = $0 }), in: 0...total) { editing in
                if !editing, let s = scrubbing { m.seek(s); scrubbing = nil }
            }
            .accessibilityLabel(Text("player.position"))
            .accessibilityValue(Text(formatClock(scrubbing ?? m.position)))
            HStack {
                Text(formatClock(scrubbing ?? m.position))
                Spacer()
                if m.buffering { ProgressView().controlSize(.mini) }
                Spacer()
                Text("-" + formatClock(max(0, total - (scrubbing ?? m.position))))
            }
            .font(Theme.body(11)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
        }
        .padding(.horizontal, 24)
    }

    private var transport: some View {
        let m = env.player
        return HStack(spacing: 30) {
            Button { m.setShuffle(!m.shuffled) } label: { Image(systemName: "shuffle").foregroundStyle(m.shuffled ? Theme.primary : Theme.mutedForeground) }
                .accessibilityLabel(Text("music.shuffle")).accessibilityAddTraits(m.shuffled ? .isSelected : [])
            Button { m.previous() } label: { Image(systemName: "backward.fill").font(.title) }.accessibilityLabel(Text("music.previous"))
            Button { m.toggle() } label: { Image(systemName: m.playing ? "pause.circle.fill" : "play.circle.fill").font(.system(size: 68)) }
                .accessibilityLabel(Text(m.playing ? "player.pause" : "player.play"))
            Button { m.next() } label: { Image(systemName: "forward.fill").font(.title) }.accessibilityLabel(Text("music.next"))
            Button { m.cycleRepeat() } label: {
                Image(systemName: m.repeatMode == .one ? "repeat.1" : "repeat").foregroundStyle(m.repeatMode == .off ? Theme.mutedForeground : Theme.primary)
            }
            .accessibilityLabel(Text(repeatLabel(m.repeatMode)))
        }
        .buttonStyle(.plain)
    }

    private func repeatLabel(_ r: RepeatMode) -> LocalizedStringKey {
        switch r {
        case .off: "music.repeat_off"
        case .all: "music.repeat_all"
        case .one: "music.repeat_one"
        }
    }

    private var bottomBar: some View {
        let m = env.player
        return HStack {
            paneButton(.lyrics, "quote.bubble", "music.lyrics")
            Spacer()
            Menu {
                Picker("player.sleep", selection: Binding(get: { sleepTag(m.sleep) }, set: { setSleep($0) })) {
                    Text("player.sleep_off").tag(0)
                    ForEach(SleepTimer.choices, id: \.self) { Text("player.sleep_min \($0)").tag($0) }
                    Text("player.sleep_end").tag(-1)
                }
            } label: {
                Image(systemName: m.sleep.isActive ? "moon.zzz.fill" : "moon.zzz").foregroundStyle(m.sleep.isActive ? Theme.primary : Theme.mutedForeground)
            }
            .accessibilityLabel(Text("player.sleep"))
            Spacer()
            RoutePicker().frame(width: 32, height: 32).accessibilityLabel(Text("player.airplay"))
            if env.showOutputs {
                Spacer()
                Button { showOutputs = true } label: { Image(systemName: "tv").foregroundStyle(Theme.mutedForeground) }
                    .accessibilityLabel(Text("player.play_on"))
            }
            Spacer()
            paneButton(.queue, "list.bullet", "music.queue")
        }
        .font(.title3)
        .padding(.horizontal, 32)
    }

    private func paneButton(_ p: Pane, _ symbol: String, _ label: LocalizedStringKey) -> some View {
        Button { withAnimation(.smooth) { pane = pane == p ? .cover : p } } label: {
            Image(systemName: symbol).foregroundStyle(pane == p ? Theme.primary : Theme.mutedForeground)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityAddTraits(pane == p ? .isSelected : [])
    }

    private func sleepTag(_ s: SleepTimer) -> Int {
        switch s {
        case .off: 0
        case .endOfTrack: -1
        case .minutes(let m, _): m
        }
    }

    private func setSleep(_ tag: Int) {
        switch tag {
        case 0: env.player.setSleep(minutes: nil)
        case -1: env.player.setSleepEndOfTrack()
        default: env.player.setSleep(minutes: tag)
        }
    }
}

/// AirPlay / Bluetooth output picker.
struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let v = AVRoutePickerView()
        v.prioritizesVideoDevices = false
        v.tintColor = UIColor(Theme.mutedForeground)
        v.activeTintColor = UIColor(Theme.primary)
        return v
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}

/// Synced lyrics (tap a line to seek), plain lyrics fallback.
struct LyricsPane: View {
    @Environment(MusicEnvironment.self) private var env

    var body: some View {
        let m = env.player
        if let synced = m.lyrics?.synced, !synced.isEmpty {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(synced.enumerated()), id: \.offset) { i, l in
                            Text(l.text.isEmpty ? "♪" : l.text)
                                .font(Theme.heading(i == m.activeLyric ? 22 : 18, weight: i == m.activeLyric ? .bold : .medium))
                                .foregroundStyle(i == m.activeLyric ? Theme.foreground : Theme.mutedForeground)
                                .id(i)
                                .onTapGesture { m.seek(Double(l.timeMs) / 1000) }
                                .accessibilityAddTraits(.isButton)
                        }
                    }
                    .padding(.horizontal, 28).padding(.vertical, 40)
                }
                .onChange(of: m.activeLyric) { _, i in if let i { withAnimation(.smooth) { proxy.scrollTo(i, anchor: .center) } } }
            }
        } else if let plain = m.lyrics?.plain, !plain.isEmpty {
            ScrollView { Text(plain).font(Theme.body(16)).foregroundStyle(Theme.mutedForeground).padding(.horizontal, 28) }
        } else {
            StateView(kind: .empty("music.no_lyrics", "music.no_lyrics_hint"), symbol: "quote.bubble")
        }
    }
}

/// Queue editor: jump, swipe to remove, drag to reorder, clear upcoming.
struct QueuePane: View {
    @Environment(MusicEnvironment.self) private var env

    var body: some View {
        let m = env.player
        List {
            Section {
                ForEach(Array(m.tracks.enumerated()), id: \.offset) { i, t in
                    Button { m.jump(to: i) } label: {
                        HStack(spacing: 10) {
                            if i == m.queue.index {
                                Image(systemName: m.playing ? "speaker.wave.2.fill" : "speaker.fill").foregroundStyle(Theme.primary).frame(width: 20)
                            } else {
                                Text("\(i + 1)").font(Theme.body(12)).monospacedDigit().foregroundStyle(Theme.mutedForeground).frame(width: 20)
                            }
                            VStack(alignment: .leading, spacing: 1) {
                                Text(t.title).font(Theme.body(14, weight: .medium)).lineLimit(1)
                                    .foregroundStyle(i < m.queue.index ? Theme.mutedForeground : Theme.foreground)
                                Text(t.artist ?? "").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
                            }
                            Spacer()
                            Text(formatClock(t.durationSec)).font(Theme.body(11)).monospacedDigit().foregroundStyle(Theme.mutedForeground)
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Color.clear)
                }
                .onDelete { m.removeFromQueue(at: $0) }
                .onMove { m.moveInQueue(from: $0, to: $1) }
            } header: {
                HStack {
                    Text("music.queue")
                    Spacer()
                    if !m.queue.upcoming.isEmpty {
                        Button("music.clear_upcoming") { m.clearUpcoming() }.font(Theme.body(12))
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .environment(\.editMode, .constant(.active))
    }
}

/// "Play on": hub devices that take a music queue (MixAI TVs, other MixAI Music apps).
struct OutputsSheet: View {
    @Environment(MusicEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @Binding var handoffError: Bool
    @State private var busy: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("music.this_device", systemImage: "iphone").foregroundStyle(Theme.primary)
                }
                Section("music.outputs_hub") {
                    if env.player.remoteOutputs.isEmpty {
                        Text("music.outputs_none").font(Theme.body(14)).foregroundStyle(Theme.mutedForeground)
                    }
                    ForEach(env.player.remoteOutputs) { o in
                        Button {
                            busy = o.id
                            Task {
                                let ok = await env.player.handoff(to: o)
                                busy = nil
                                if ok { dismiss() } else { handoffError = true }
                            }
                        } label: {
                            HStack {
                                Label(o.name, systemImage: o.platform.contains("tv") ? "tv" : "hifispeaker")
                                Spacer()
                                if busy == o.id { ProgressView() }
                            }
                        }
                        .disabled(busy != nil)
                    }
                }
                Section { Text("music.outputs_airplay_hint").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground) }
            }
            .navigationTitle("player.play_on")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// Compact player for the tab bar bottom accessory.
public struct MiniPlayer: View {
    @Environment(MusicEnvironment.self) private var env

    public init() {}

    public var body: some View {
        let m = env.player
        HStack(spacing: 10) {
            RemoteImage(url: env.cover(m.current?.coverUrlPath), aspect: 1, placeholderSymbol: "music.note").frame(width: 34, height: 34).clipShape(.rect(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 0) {
                Text(m.current?.title ?? "").font(Theme.body(14, weight: .semibold)).lineLimit(1)
                Text(m.current?.artist ?? "").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button { m.toggle() } label: { Image(systemName: m.playing ? "pause.fill" : "play.fill") }
                .accessibilityLabel(Text(m.playing ? "player.pause" : "player.play"))
            Button { m.next() } label: { Image(systemName: "forward.fill") }
                .accessibilityLabel(Text("music.next"))
        }
        .padding(.horizontal, 14)
        .contentShape(.rect)
        .onTapGesture { m.showNowPlaying = true }
        .accessibilityAction(named: Text("music.open_now_playing")) { m.showNowPlaying = true }
    }
}
