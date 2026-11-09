import MixaiCore
import MixaiUI
import SwiftUI
import UniformTypeIdentifiers

/// Live tab (port of Android LiveScreen): wheel, key + BPM, key-change line, chord / tuning / energy / loudness,
/// chroma, mix next, notation, Listen / file / stage / save, Song ID card.
struct LiveView: View {
    @Environment(ListenSession.self) private var s
    @Binding var stage: Bool
    @State private var picking = false
    @Environment(\.verticalSizeClass) private var vClass

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                if let f = s.fileName { Text("kb.file.header \(f)").font(Theme.body(14)).foregroundStyle(KB.muted) }
                CamelotWheel(keyIndex: s.reading?.keyIndex, pulse: { s.listening ? s.clock.pulse(now: $0) : 0 })
                    .frame(maxWidth: 420)
                readouts
                if let k = s.keyChange {
                    Text("kb.key_changed \(Harmony.camelot(k))").font(Theme.body(15, weight: .semibold)).foregroundStyle(KB.warning)
                        .accessibilityAddTraits(.updatesFrequently)
                        .onTapGesture { s.dismissKeyChange() }
                }
                if let ak = s.appleKey {
                    Text("kb.apple_key \(s.notation.label(ak))").font(Theme.body(13)).foregroundStyle(KB.muted)
                }
                if let r = s.reading { details(r) } else { placeholder }
                notationPicker
                buttons
                if !s.isFileMode && s.songIdEngine.available { SongIdCard() }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
        .background(KB.bg)
        .fileImporter(isPresented: $picking, allowedContentTypes: [.audio]) { result in
            if case .success(let url) = result { Task { await s.analyze(url: url) } }
        }
    }

    private var readouts: some View {
        let r = s.reading
        let keyText = r?.keyIndex.map { s.notation.label($0) } ?? "\u{2014}"
        let keyDetail = r?.keyIndex == nil ? "" : "\((r?.keyLocked == true ? String(localized: "kb.locked") : String(localized: "kb.provisional"))) \u{00B7} \(String(localized: "kb.confidence \(Int(((r?.keyConfidence ?? 0) * 100).rounded()))"))"
        let keySub = r.flatMap { rr in rr.keyIndex.map { k in
            "\(String(localized: "kb.alternative \(rr.alternativeIndex.map { s.notation.label($0) } ?? "\u{2014}")")) \u{00B7} \(Harmony.longName(k))"
        } }
        let bpmDetail = r?.bpm == nil ? "" : "\((r?.tempoLocked == true ? String(localized: "kb.locked") : String(localized: "kb.provisional"))) \u{00B7} \(String(localized: "kb.confidence \(Int(((r?.tempoConfidence ?? 0) * 100).rounded()))"))"
        return HStack(alignment: .top) {
            Readout(label: "kb.key", value: keyText, detail: keyDetail, sub: keySub, color: r?.keyIndex.map(KB.keyColor) ?? KB.fg)
            VStack(spacing: 6) {
                Readout(label: "kb.bpm", value: KB.bpm(s.bpm), detail: bpmDetail)
                if s.bpm != nil {
                    Button { s.cycleTempo() } label: {
                        Text(s.tempoFactor == 0.5 ? LocalizedStringKey("kb.half_tempo") : (s.tempoFactor == 2 ? LocalizedStringKey("kb.double_tempo") : LocalizedStringKey("kb.tempo_cycle")))
                    }
                    .buttonStyle(.glass).controlSize(.small)
                    .accessibilityHint(Text("kb.tempo_cycle_hint"))
                }
            }
        }
    }

    @ViewBuilder private func details(_ r: Reading) -> some View {
        Card {
            InfoRow(label: "kb.chord", value: r.chord ?? "\u{2014}")
            InfoRow(label: "kb.tuning", value: String(localized: "kb.tuning_value \(String(format: "%.1f", r.tuningA4)) \(String(format: "%+d", Int(r.tuningCents.rounded())))"))
            if let e = r.energy { InfoRow(label: "kb.energy", value: String(format: "%.1f / 10", e)) }
            if let l = r.lufs { InfoRow(label: "kb.loudness", value: String(localized: "kb.lufs \(String(format: "%.0f", l))")) }
            if r.levelDbfs < -55, s.listening { Text("kb.level_low").font(Theme.body(13)).foregroundStyle(KB.warning) }
            ChromaBars(chroma: r.chroma)
        }
        if let k = r.keyIndex {
            VStack(alignment: .leading, spacing: 8) {
                Text("kb.mix_next").font(Theme.body(13, weight: .semibold)).foregroundStyle(KB.muted)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(Harmony.mixNextLabels(k), id: \.key) { m in
                            Text("\(s.notation.label(m.key)) \u{00B7} \(String(localized: String.LocalizationValue(m.label)))")
                                .font(Theme.body(13)).padding(.horizontal, 12).padding(.vertical, 6)
                                .background(KB.keyColor(m.key).opacity(0.22), in: Capsule())
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var placeholder: some View {
        if s.analysing { VStack { ProgressView(); Text("kb.analysing").foregroundStyle(KB.muted) } }
        else if s.fileError { Text("kb.file_error").foregroundStyle(KB.error).multilineTextAlignment(.center) }
        else if s.listening { VStack { ProgressView(); Text("kb.listening").foregroundStyle(KB.muted) } }
        else { Text("kb.idle_hint").font(Theme.body(15)).foregroundStyle(KB.muted).multilineTextAlignment(.center) }
    }

    private var notationPicker: some View {
        @Bindable var s = s
        return Picker("kb.notation", selection: $s.notation) {
            Text("kb.notation.camelot").tag(Notation.camelot)
            Text("kb.notation.open_key").tag(Notation.openKey)
            Text("kb.notation.musical").tag(Notation.musical)
        }
        .pickerStyle(.segmented)
    }

    private var buttons: some View {
        VStack(spacing: 10) {
            HStack {
                if s.listening {
                    Button("kb.listen_again") { Task { await s.restart() } }.buttonStyle(.glass)
                    Button("kb.stop") { s.stop() }.buttonStyle(.glassProminent).tint(KB.error)
                } else {
                    Button { Task { await s.start() } } label: { Label("kb.listen", systemImage: "waveform").frame(maxWidth: .infinity) }
                        .buttonStyle(.glassProminent)
                }
            }
            .controlSize(.large)
            HStack {
                Button { picking = true } label: { Label("kb.open_file", systemImage: "doc.badge.plus") }
                    .buttonStyle(.glass).disabled(s.analysing)
                if s.listening {
                    Button { stage = true } label: { Label("kb.stage_mode", systemImage: "rectangle.expand.vertical") }.buttonStyle(.glass)
                }
                if s.reading?.keyIndex != nil, s.bpm != nil {
                    Button(s.saved ? LocalizedStringKey("kb.saved") : LocalizedStringKey("kb.save")) { s.save() }.buttonStyle(.glass).disabled(s.saved)
                }
            }
        }
    }
}

/// Song ID card (Identify, tracklist mode, result with links, library badge, queue).
struct SongIdCard: View {
    @Environment(ListenSession.self) private var s
    @Environment(\.openURL) private var openURL

    var body: some View {
        Card {
            HStack {
                Text("kb.songid.title").font(Theme.body(16, weight: .semibold))
                Spacer()
                Button("kb.songid.identify") { s.identify() }.buttonStyle(.glassProminent).controlSize(.small)
                    .disabled(!s.listening || s.songId == .collecting || s.songId == .matching)
            }
            Toggle(isOn: Binding(get: { s.prefs.tracklistMode }, set: { s.setTracklistMode($0) })) {
                VStack(alignment: .leading) {
                    Text("kb.songid.tracklist")
                    Text("kb.songid.tracklist_hint").font(Theme.body(12)).foregroundStyle(KB.muted)
                }
            }
            status
            if s.pendingIds > 0 { Text("kb.songid.pending \(s.pendingIds)").font(Theme.body(12)).foregroundStyle(KB.muted) }
            Text("kb.songid.privacy").font(Theme.body(11)).foregroundStyle(KB.muted)
        }
    }

    @ViewBuilder private var status: some View {
        switch s.songId {
        case .idle: if !s.listening { Text("kb.songid.need_listen").foregroundStyle(KB.muted) }
        case .collecting: HStack { ProgressView(); Text("kb.songid.collecting") }
        case .matching: HStack { ProgressView(); Text("kb.songid.matching") }
        case .noMatch: Text("kb.songid.no_match").foregroundStyle(KB.muted)
        case .offline: Text("kb.songid.offline").foregroundStyle(KB.warning)
        case .error(let r): Text("kb.songid.error \(r)").foregroundStyle(KB.error)
        case .found(let m, let queued): found(m, queued: queued)
        }
    }

    private func found(_ m: SongMatch, queued: Bool) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                AsyncImage(url: m.artworkUrl.flatMap(URL.init(string:))) { $0.resizable().scaledToFill() } placeholder: { KB.primary.opacity(0.2) }
                    .frame(width: 64, height: 64).clipShape(.rect(cornerRadius: 8)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.title).font(Theme.body(16, weight: .semibold)).lineLimit(2)
                    if let a = m.artist { Text(a).foregroundStyle(KB.muted) }
                    if m.libraryTrackId != nil { Text("kb.songid.in_library").font(Theme.body(12)).foregroundStyle(KB.success) }
                }
            }
            if m.libraryCamelot != nil || m.libraryBpm != nil {
                let live = [s.reading?.keyIndex.map(Harmony.camelot), s.bpm.map { String(format: "%.1f", $0) }].compactMap { $0 }.joined(separator: " \u{00B7} ")
                let lib = [m.libraryCamelot, m.libraryBpm.map { String(format: "%.1f", $0) }].compactMap { $0 }.joined(separator: " \u{00B7} ")
                Text("kb.songid.compare \(live.isEmpty ? "\u{2014}" : live) \(lib)").font(Theme.body(12)).foregroundStyle(KB.muted)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    if let u = m.appleMusicUrl.flatMap(URL.init(string:)) { Button("kb.songid.apple_music") { openURL(u) }.buttonStyle(.glass) }
                    if let u = m.spotifyURL { Button("kb.songid.spotify") { openURL(u) }.buttonStyle(.glass) }
                    if let u = m.youTubeMusicURL { Button("kb.songid.youtube_music") { openURL(u) }.buttonStyle(.glass) }
                    if m.libraryTrackId != nil {
                        Button(queued ? LocalizedStringKey("kb.songid.queued") : LocalizedStringKey("kb.songid.add_queue")) { Task { await s.addFoundToQueue() } }
                            .buttonStyle(.glass).disabled(queued)
                    }
                }
                .controlSize(.small)
            }
        }
    }
}
