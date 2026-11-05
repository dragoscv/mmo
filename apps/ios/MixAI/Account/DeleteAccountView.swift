import MixaiCore
import SwiftUI

/// In-app account deletion (App Store 5.1.1(v)): type DELETE to confirm.
struct DeleteAccountView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var done = false

    var body: some View {
        let store = app.accountStore
        Form {
            if done {
                Section {
                    Label("account.delete.done", systemImage: "checkmark.circle.fill").foregroundStyle(Theme.success)
                }
            } else {
                Section {
                    Text("account.delete.body").font(Theme.body(14))
                } header: { Text("account.delete.title") }
                Section {
                    TextField("account.delete.type_hint", text: $text)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .accessibilityLabel(Text("account.delete.type_hint"))
                    if let e = store.error { Text(e).font(Theme.body(13)).foregroundStyle(Theme.destructive) }
                    Button(role: .destructive) {
                        Task { done = await store.deleteAccount(confirmation: text, app: app) }
                    } label: {
                        if store.busy { ProgressView() } else { Text("account.delete.confirm") }
                    }
                    .disabled(text != "DELETE" || store.busy || !store.signedIn)
                }
            }
            Section {
                if let u = URL(string: app.origin + "/account/delete") {
                    Link("account.delete.web", destination: u)
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("account.delete.title")
    }
}
