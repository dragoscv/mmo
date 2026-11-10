import DecksFFI
import SwiftUI
import UniformTypeIdentifiers

/// Import from rekordbox / Serato / Traktor (WP19-38) as a sheet: pick a file or folder
/// (`fileImporter`), see a read-only preview, choose the conflict policy, drift correction and
/// relocation folders, then import and read the report. Takes the `DecksLibrary` handle and an
/// `onImported` closure (the owner refreshes its views) so `LibraryStore` stays untouched.
/// Flow and quirks: docs/decks/library-interop.md.
struct ImportView: View {
    let library: DecksLibrary?
    var onImported: () -> Void = {}

    private enum Source: String, CaseIterable, Identifiable {
        case auto, rekordbox, serato, traktor
        var id: String { rawValue }
    }

    private enum Picking { case source, relocate }

    @Environment(\.dismiss) private var dismiss
    @State private var source: Source = .auto
    @State private var picking = false
    /// What the open panel was started for. It is kept apart from the `isPresented` flag on purpose:
    /// that flag is cleared by SwiftUI before the completion handler runs, so a single optional
    /// would already be `nil` there and a relocation folder would be taken for a new source.
    @State private var pickMode: Picking = .source
    @State private var format: LibraryFormat?
    @State private var path: String?
    @State private var scoped: [URL] = []
    @State private var conflict: ImportConflict = .preferImported
    @State private var correctDrift = true
    @State private var roots: [URL] = []
    @State private var preview: ImportPreviewRecord?
    @State private var report: ImportRunReport?
    @State private var message: String?
    @State private var busy = false
    /// Confirm before writing: an import can update tracks, cues and playlists already in the library.
    @State private var confirmingRun = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("import.source", selection: $source) {
                        Text("import.source.auto").tag(Source.auto)
                        Text(verbatim: "rekordbox").tag(Source.rekordbox)
                        Text(verbatim: "Serato").tag(Source.serato)
                        Text(verbatim: "Traktor").tag(Source.traktor)
                    }
                    Button("import.pick") { pickMode = .source; picking = true }
                        .disabled(library == nil || busy)
                    if let path {
                        Text(verbatim: path).font(.caption).lineLimit(1).truncationMode(.middle)
                            .foregroundStyle(DecksTheme.muted)
                    }
                    if let message {
                        Text(verbatim: message).font(.caption).foregroundStyle(DecksTheme.danger)
                    }
                } header: {
                    Text("import.title")
                }

                if let p = preview, report == nil {
                    Section {
                        row("import.tracks_seen", p.tracksSeen)
                        row("import.new", p.newTracks)
                        row("import.matched_path", p.matchedByPath)
                        row("import.matched_hash", p.matchedByHash)
                        row("import.missing", p.missingFiles, warn: p.missingFiles > 0)
                        if p.relocatable > 0 { row("import.relocatable", p.relocatable) }
                        row("import.cues", p.cues)
                        row("import.grids", p.grids)
                        row("import.playlists", p.playlists)
                        if !p.warnings.isEmpty { row("import.warnings", UInt32(p.warnings.count), warn: true) }
                        ForEach(p.missingSample.prefix(3), id: \.self) { m in
                            Text(verbatim: m).font(.caption).lineLimit(1).truncationMode(.middle)
                                .foregroundStyle(DecksTheme.muted)
                        }
                        if p.protected {
                            Text("import.protected").foregroundStyle(DecksTheme.warning)
                        }
                    } header: {
                        Text("import.preview")
                    }
                    Section {
                        Picker("import.conflict", selection: $conflict) {
                            Text("import.conflict.keep").tag(ImportConflict.keepExisting)
                            Text("import.conflict.prefer").tag(ImportConflict.preferImported)
                            Text("import.conflict.merge").tag(ImportConflict.merge)
                        }
                        Toggle("import.drift", isOn: $correctDrift)
                        ForEach(roots, id: \.self) { u in
                            Text(verbatim: u.path).font(.caption).lineLimit(1).truncationMode(.middle)
                        }
                        .onDelete { idx in
                            roots.remove(atOffsets: idx)
                            refreshPreview()
                        }
                        Button("import.relocate") { pickMode = .relocate; picking = true }.disabled(busy)
                        Button {
                            confirmingRun = true
                        } label: {
                            if busy { ProgressView() } else { Text("import.run") }
                        }
                        .disabled(busy || p.protected)
                    } header: {
                        Text("import.options")
                    }
                }

                if let r = report {
                    Section {
                        row("import.inserted", r.summary.tracksInserted)
                        row("import.updated", r.summary.tracksMergedByPath + r.summary.tracksMergedByHash)
                        row("import.cues", r.summary.cuesImported)
                        row("import.playlists", r.summary.playlistsImported)
                        if r.relocated > 0 { row("import.relocated", r.relocated) }
                        if r.driftFixes > 0 { row("import.drift_fixes", r.driftFixes) }
                        if !r.summary.unmatchedFiles.isEmpty {
                            row("import.still_missing", UInt32(r.summary.unmatchedFiles.count), warn: true)
                        }
                        if !r.summary.warnings.isEmpty {
                            row("import.warnings", UInt32(r.summary.warnings.count), warn: true)
                            ForEach(r.summary.warnings.prefix(3), id: \.self) { w in
                                Text(verbatim: w).font(.caption).foregroundStyle(DecksTheme.muted)
                            }
                        }
                    } header: {
                        Text("import.report")
                    }
                    .accessibilityElement(children: .contain)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(Text("import.title"))
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("import.close") { close() }.disabled(busy)
                }
            }
            .fileImporter(
                isPresented: $picking,
                allowedContentTypes: pickMode == .relocate ? [.folder] : [.xml, .folder, .data, .item],
                allowsMultipleSelection: false
            ) { result in
                let mode = pickMode
                guard case let .success(urls) = result, let url = urls.first else { return }
                if url.startAccessingSecurityScopedResource() { scoped.append(url) }
                if mode == .relocate {
                    if !roots.contains(url) { roots.append(url) }
                    refreshPreview()
                } else {
                    resolve(url)
                }
            }
            .confirmationDialog(
                "import.confirm",
                isPresented: $confirmingRun,
                titleVisibility: .visible
            ) {
                Button("import.run") { run() }
                Button("common.cancel", role: .cancel) { confirmingRun = false }
            }
            .onChange(of: conflict) { _, _ in message = nil }
            .onChange(of: correctDrift) { _, _ in message = nil }
        }
    }

    private func row(_ key: LocalizedStringKey, _ value: UInt32, warn: Bool = false) -> some View {
        LabeledContent(key) {
            Text(verbatim: "\(value)").monospacedDigit().foregroundStyle(warn ? DecksTheme.warning : DecksTheme.foreground)
        }
    }

    private var options: ImportOptions {
        ImportOptions(conflict: conflict, relocateRoots: roots.map(\.path), correctDrift: correctDrift)
    }

    /// Picks the format: auto-detect, or the chosen app (falling back to detection for Serato
    /// folders and rekordbox USB sticks, which need a volume root).
    private func resolve(_ url: URL) {
        message = nil
        report = nil
        preview = nil
        let detected = detectImportFormat(path: url.path)
        switch source {
        case .auto:
            guard let detected else {
                message = String(localized: "import.not_recognised")
                return
            }
            format = detected.format
            path = detected.path
        case .rekordbox:
            if let d = detected, case .rekordboxPdb = d.format {
                format = d.format
                path = d.path
            } else {
                format = .rekordboxXml
                path = url.path
            }
        case .traktor:
            format = .traktorNml
            path = url.path
        case .serato:
            if let d = detected, case .seratoCrates = d.format {
                format = d.format
                path = d.path
            } else {
                format = .seratoCrates(volumeRoot: Self.volumeRoot(url))
                path = url.path
            }
        }
        refreshPreview()
    }

    private static func volumeRoot(_ url: URL) -> String {
        let parts = url.standardizedFileURL.pathComponents
        if parts.count > 2, parts[1] == "Volumes" { return "/Volumes/\(parts[2])" }
        return "/"
    }

    private func refreshPreview() {
        guard let library, let format, let path else { return }
        busy = true
        let opts = options
        Task.detached {
            let result = Result { try importPreview(library: library, format: format, path: path, options: opts) }
            await MainActor.run {
                busy = false
                switch result {
                case let .success(p): preview = p
                case let .failure(e): fail(e)
                }
            }
        }
    }

    private func run() {
        guard let library, let format, let path else { return }
        busy = true
        let opts = options
        Task.detached {
            let result = Result { try importRun(library: library, format: format, path: path, options: opts) }
            await MainActor.run {
                busy = false
                switch result {
                case let .success(r):
                    report = r
                    message = nil
                    onImported()
                case let .failure(e): fail(e)
                }
            }
        }
    }

    private func fail(_ error: Error) {
        // `DecksError.Protected` (WP19-40 lock); compared by case label so the generated casing does not matter.
        let caseLabel = Mirror(reflecting: error).children.first?.label?.lowercased()
        if error is DecksError, caseLabel == "protected" {
            message = String(localized: "import.protected")
            return
        }
        // Every DecksError case carries one `reason` field; read it without naming the cases.
        let payload = Mirror(reflecting: error).children.first?.value
        let reason = payload.flatMap { Mirror(reflecting: $0).children.first { $0.label == "reason" }?.value as? String }
        message = String(format: String(localized: "import.failed %@"), reason ?? error.localizedDescription)
    }

    private func close() {
        scoped.forEach { $0.stopAccessingSecurityScopedResource() }
        scoped.removeAll()
        dismiss()
    }
}
