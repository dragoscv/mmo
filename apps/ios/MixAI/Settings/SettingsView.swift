import MixaiCore
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var originDraft = ""
    @State private var serverVersion: String?

    var body: some View {
        @Bindable var model = app
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
                if app.activeProfile?.kind != .kid {
                    NavigationLink(value: Route.family) { Label("family.title", systemImage: "chart.bar.xaxis") }
                }
            }
            if app.activeProfile?.kind == .kid { KidsCapView() }
            accountSection
            notificationsSection
            Section("settings.playback") {
                Toggle(isOn: $model.dataSaver) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("settings.data_saver")
                        Text("settings.data_saver_hint").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                    }
                }
                NavigationLink(value: Route.downloads) { Label("downloads.title", systemImage: "arrow.down.circle") }
            }
            Section("settings.features") {
                NavigationLink(value: Route.remote) { Label("remote.title", systemImage: "appletvremote.gen4") }
                NavigationLink(value: Route.together) { Label("together.title", systemImage: "person.2.wave.2") }
                NavigationLink(value: Route.plex) { Label("plex.title", systemImage: "square.and.arrow.down.on.square") }
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
                NavigationLink(value: Route.licenses) { Text("licenses.title") }
                LabeledContent("settings.carplay", value: String(localized: "carplay.pending"))
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("settings.title")
        .onAppear { originDraft = app.origin }
        .task {
            serverVersion = try? await app.client?.health().version
            await app.push.refresh(app: app)
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        let store = app.accountStore
        Section {
            if store.signedIn {
                LabeledContent("settings.signed_in_as", value: store.user?.name ?? app.account?.name ?? "-")
                if let e = store.user?.email { LabeledContent("account.email", value: e) }
                Button("account.sign_out") { Task { await store.signOut(app: app) } }
                NavigationLink(value: Route.deleteAccount) { Text("settings.delete_account").foregroundStyle(Theme.destructive) }
            } else {
                Text("account.why").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                AppleSignInButton().listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                Button {
                    Task { await store.signInWithGoogleWeb(app: app) }
                } label: {
                    if store.busy, let code = store.webCode { Text("account.google_code \(code)") } else { Label("account.google", systemImage: "globe") }
                }
                .disabled(store.busy)
                if let u = URL(string: app.origin + "/activate") {
                    Link("account.other_device", destination: u).font(Theme.body(13))
                }
            }
            if let e = store.error { Text(e).font(Theme.body(13)).foregroundStyle(Theme.destructive) }
            TextField("settings.web_origin", text: $originDraft)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                .onSubmit { app.setOrigin(originDraft) }
        } header: { Text("settings.account") }
    }

    @ViewBuilder
    private var notificationsSection: some View {
        Section {
            if app.accountStore.signedIn {
                LabeledContent("settings.notifications_status") { Text(app.push.statusText) }
                if !app.push.authorized {
                    Button("settings.notifications_enable") { Task { await app.push.requestAuthorization(app: app) } }
                }
                if app.push.status == .denied, let u = URL(string: UIApplication.openSettingsURLString) {
                    Button("settings.open_system_settings") { openURL(u) }
                }
                Text(app.activities.enabled ? LocalizedStringKey("settings.live_activities_on") : LocalizedStringKey("settings.live_activities_off"))
                    .font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
            } else {
                Text("settings.notifications_need_account").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
            }
        } header: { Text("settings.notifications") }
    }
}
