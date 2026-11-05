import MixaiCore
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var originDraft = ""
    @State private var serverVersion: String?

    var body: some View {
        Form {
            Section("settings.server") {
                LabeledContent("settings.server_name", value: app.server?.name ?? "-")
                LabeledContent("settings.server_url", value: app.server?.baseURL ?? "-")
                if let v = serverVersion { LabeledContent("settings.server_version", value: v) }
                Button("settings.disconnect", role: .destructive) { app.signOutServer() }
            }
            Section("settings.profiles") {
                LabeledContent("settings.active_profile", value: app.activeProfile?.name ?? "-")
                Button("settings.switch_profile") { Task { await app.switchProfile() } }
            }
            Section("settings.account") {
                LabeledContent("settings.signed_in_as", value: app.account?.name ?? String(localized: "settings.not_signed_in"))
                TextField("settings.web_origin", text: $originDraft)
                    .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    .onSubmit { app.setOrigin(originDraft) }
                Button("settings.delete_account", role: .destructive) {
                    if let u = URL(string: app.origin + "/account/delete") { openURL(u) }
                }
            }
            Section("settings.language") {
                Picker("settings.language", selection: Binding(get: { app.language }, set: { app.setLanguage($0) })) {
                    Text("settings.language_system").tag("system")
                    Text(verbatim: "English").tag("en")
                    Text(verbatim: "Română").tag("ro")
                }
            }
            Section("settings.about") {
                LabeledContent("settings.version", value: ClientIdentity.current.appVersion)
                Link("settings.privacy", destination: URL(string: app.origin + "/privacy")!)
                Link("settings.terms", destination: URL(string: app.origin + "/terms")!)
                Text("settings.licences").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("settings.title")
        .onAppear { originDraft = app.origin }
        .task { serverVersion = try? await app.client?.health().version }
    }
}
