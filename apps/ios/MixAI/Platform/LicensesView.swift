import SwiftUI

/// Third-party notices: bundled fonts (OFL), VLCKit (LGPL, dynamically linked), sentry-cocoa (MIT).
struct LicensesView: View {
    @State private var ofl: String = Bundle.main.url(forResource: "OFL", withExtension: "txt").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""

    var body: some View {
        List {
            Section {
                Text(verbatim: "Inter, Space Grotesk").font(Theme.body(15, weight: .semibold))
                Text(verbatim: "SIL Open Font License 1.1").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                if !ofl.isEmpty {
                    DisclosureGroup("licenses.full_text") {
                        Text(verbatim: ofl).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
                    }
                }
            } header: { Text("licenses.fonts") }
            Section {
                Text(verbatim: "VLCKit").font(Theme.body(15, weight: .semibold))
                Text(verbatim: "GNU LGPL-2.1-or-later").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                Text("licenses.vlckit_note").font(Theme.body(13))
                Link(destination: URL(string: "https://code.videolan.org/videolan/VLCKit")!) { Text(verbatim: "code.videolan.org/videolan/VLCKit") }
            } header: { Text("licenses.libraries") }
            Section {
                Text(verbatim: "sentry-cocoa").font(Theme.body(15, weight: .semibold))
                Text(verbatim: "MIT License · Copyright (c) Sentry").font(Theme.body(13)).foregroundStyle(Theme.mutedForeground)
                Link(destination: URL(string: "https://github.com/getsentry/sentry-cocoa")!) { Text(verbatim: "github.com/getsentry/sentry-cocoa") }
            }
        }
        .scrollContentBackground(.hidden)
        .background(Theme.background)
        .navigationTitle("licenses.title")
    }
}
