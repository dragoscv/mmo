import DecksFFI
import SwiftUI

/// Settings section for skins, layouts and `.mixaipack` packs (WP19-34). Embed it in a `Form`:
/// `AppearanceSettingsSection()`. Reads [AppearanceStore.shared], so it works in the iOS sheet and in the
/// separate macOS `Settings` scene alike.
struct AppearanceSettingsSection: View {
    @State private var appearance = AppearanceStore.shared
    @State private var importing = false

    var body: some View {
        Section {
            Picker("appearance.skin", selection: Binding(get: { appearance.dark }, set: { appearance.setDark($0) })) {
                Text("appearance.skin.dark").tag(true)
                Text("appearance.skin.light").tag(false)
            }
            .pickerStyle(.segmented)
            Picker("appearance.accent", selection: Binding(get: { appearance.accent }, set: { appearance.setAccent($0) })) {
                ForEach(DecksPalette.accentNames, id: \.self) { name in
                    Label {
                        Text(verbatim: name.prefix(1).uppercased() + name.dropFirst())
                    } icon: {
                        Circle().fill(DecksOklab.color(l: 0.70, c: 0.17, h: DecksPalette.hue(name))).frame(width: 12, height: 12)
                    }
                    .tag(name)
                }
            }
            Picker("appearance.layout", selection: Binding(get: { appearance.currentLayout?.id ?? "classic" }, set: { appearance.setLayout($0) })) {
                ForEach(appearance.layouts) { l in
                    Text(verbatim: PanelNames.layout(l)).tag(l.id)
                }
            }
            Picker("appearance.pack", selection: Binding(get: { appearance.packId }, set: { appearance.setPack($0) })) {
                Text("appearance.pack.none").tag(String?.none)
                ForEach(appearance.skinPacks, id: \.id) { p in
                    Text(verbatim: p.name).tag(String?.some(p.id))
                }
            }
            ForEach(appearance.packs, id: \.id) { p in
                LabeledContent {
                    Button("appearance.pack.remove", role: .destructive) { appearance.remove(p.id) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: p.name)
                        Text(verbatim: "\(p.author) · \(p.version) · \(trustLabel(p.trust))")
                            .font(.caption).foregroundStyle(DecksTheme.muted)
                    }
                }
            }
            Button("appearance.pack.import") { importing = true }
            if let result = appearance.lastImport {
                switch result {
                case let .success(name):
                    Text("appearance.pack.installed \(name)").font(.caption).foregroundStyle(DecksTheme.success)
                case let .failure(e):
                    Text("appearance.pack.rejected \(e.reason)").font(.caption).foregroundStyle(DecksTheme.danger)
                }
            }
        } header: {
            Text("appearance.title")
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.mixaiPack, .zip]) { result in
            if case let .success(url) = result { appearance.importPack(from: url) }
        }
    }

    private func trustLabel(_ t: PackTrustLevel) -> String {
        switch t {
        case .official: "official"
        case .verified: "verified"
        case .community: "community"
        case .unsigned: "unsigned"
        }
    }
}
