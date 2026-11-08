import MixaiCore
import MixaiUI
import SwiftUI

/// Playback (crossfade, normalisation, animated artwork), downloads (Wi-Fi only, upcoming, limit), profile,
/// server, account, CarPlay status, about.
struct MusicSettingsView: View {
    @Environment(MusicAppModel.self) private var app
    @State private var confirmDisconnect = false

    var body: some View {
        @Bindable var player = app.player
        @Bindable var dl = app.downloads
        Form {
            Section {
                Picker("music.settings.crossfade", selection: Binding(get: { player.prefs.crossfadeMs / 1000 }, set: { player.prefs.crossfadeMs = $0 * 1000 })) {
                    ForEach(AudioPrefs.crossfadeChoices, id: \.self) { s in
                        if s == 0 { Text("music.settings.crossfade_off").tag(0) } else { Text("music.settings.seconds \(s)").tag(s) }
                    }
                }
                Toggle("music.settings.normalize", isOn: $player.prefs.normalize)
                Toggle("music.settings.animated_artwork", isOn: $player.animatedArtwork)
            } header: { Text("settings.playback") } footer: { Text("music.settings.playback_footer") }

            Section {
                Toggle("downloads.wifi_only_toggle", isOn: $dl.wifiOnly)
                Picker("music.settings.upcoming", selection: $dl.upcomingCount) {
                    ForEach(MusicOffline.upcomingChoices, id: \.self) { n in
                        if n == 0 { Text("music.settings.upcoming_off").tag(0) } else { Text("music.tracks_count \(n)").tag(n) }
                    }
                }
                Picker("music.settings.limit", selection: $dl.limitGB) {
                    ForEach(MusicOffline.limitChoicesGB, id: \.self) { g in
                        if g == 0 { Text("music.settings.limit_none").tag(0) } else { Text(verbatim: "\(g) GB").tag(g) }
                    }
                }
            } header: { Text("downloads.title") } footer: { Text("music.settings.downloads_footer") }

            Section("settings.profiles") {
                LabeledContent("settings.active_profile", value: app.activeProfile?.name ?? "—")
                if app.profiles.count > 1 {
                    Button("settings.switch_profile") { Task { await app.switchProfile() } }
                }
            }

            Section("settings.server") {
                LabeledContent("settings.server_name", value: app.server?.name ?? "—")
                LabeledContent("settings.server_url", value: app.server?.baseURL ?? "—")
                Button("settings.disconnect", role: .destructive) { confirmDisconnect = true }
            }

            Section("settings.account") {
                if let u = app.account {
                    LabeledContent("settings.signed_in_as", value: u.name ?? u.id)
                    Button("music.settings.sign_out", role: .destructive) { app.signOutAccount() }
                    if let url = URL(string: app.origin + "/account/delete") {
                        Link("settings.delete_account", destination: url)
                    }
                } else {
                    Text("settings.not_signed_in").foregroundStyle(Theme.mutedForeground)
                    NavigationLink(value: SettingsRoute.signIn) { Text("welcome.sign_in") }
                }
            }

            Section("settings.features") {
                LabeledContent("settings.carplay", value: String(localized: "carplay.pending"))
            }

            Section("settings.about") {
                LabeledContent("settings.version", value: Self.version)
                if let u = URL(string: "https://mixai.ro/privacy") { Link("settings.privacy", destination: u) }
                // No custom EULA: the App Store's standard licence applies (mixai.ro has no /terms page).
                if let u = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/") { Link("settings.terms", destination: u) }
                NavigationLink { MusicLicensesView() } label: { Text("settings.licences") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("settings.title")
        .confirmationDialog("music.settings.disconnect_confirm", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("settings.disconnect", role: .destructive) { app.disconnect() }
        }
    }

    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }
}

/// Third-party notices: bundled fonts (OFL), AudioStreaming (MIT) and the Xiph ogg/vorbis frameworks it links (BSD-3).
struct MusicLicensesView: View {
    @State private var ofl: String = Bundle.main.url(forResource: "OFL", withExtension: "txt").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(verbatim: "AudioStreaming 1.4.5 — MIT License — © Dimitrios Chatzieleftheriou").font(Theme.body(14, weight: .semibold))
                Text(verbatim: "https://github.com/dimitris-c/AudioStreaming").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                Text(verbatim: "libogg, libvorbis — BSD-3-Clause — © Xiph.Org Foundation (via ogg/vorbis-binary-xcframework 0.1.2)").font(Theme.body(14, weight: .semibold))
                Divider()
                Text(verbatim: "Space Grotesk, Inter — SIL Open Font License 1.1").font(Theme.body(14, weight: .semibold))
                Text(ofl).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.mutedForeground)
            }
            .padding(20)
        }
        .background(Theme.background)
        .navigationTitle("settings.licences")
    }
}
