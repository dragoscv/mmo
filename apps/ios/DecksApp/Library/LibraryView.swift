import DecksFFI
import SwiftUI
import UniformTypeIdentifiers

/// Library browser: folders (fileImporter + security-scoped bookmarks), search, crates, load to A / B.
struct LibraryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DecksStore.self) private var store
    @Environment(BrowserCursor.self) private var cursor
    @State private var importing = false
    @State private var newCrate = ""
    @State private var askingCrate = false

    var body: some View {
        @Bindable var library = library
        @Bindable var cursor = cursor
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(DecksTheme.muted).accessibilityHidden(true)
                TextField("library.search", text: $library.query)
                    .textFieldStyle(.plain)
                    .accessibilityLabel(Text("library.search"))
                crateMenu
                Button { importing = true } label: { Label("library.add_folder", systemImage: "folder.badge.plus") }
                    .keyboardShortcut("o", modifiers: .command)
                Button { library.rescanAll() } label: { Label("library.rescan", systemImage: "arrow.clockwise") }
                    .disabled(library.folders.isEmpty || library.isScanning)
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 10).fill(DecksTheme.raised))
            if let s = library.scan, s.state == .running {
                ProgressView(value: Double(s.done), total: Double(max(1, s.total))) {
                    Text("library.scanning \(Int(s.done)) \(Int(s.total))").font(.caption)
                }
                .tint(DecksTheme.accent)
            }
            if library.tracks.isEmpty {
                ContentUnavailableView {
                    Label("library.empty.title", systemImage: "music.note.list")
                } description: {
                    Text("library.empty.body")
                } actions: {
                    Button("library.add_folder") { importing = true }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: $cursor.selection) {
                    ForEach(library.tracks, id: \.rowId) { t in
                        TrackRow(track: t) { deck in load(t, deck: deck) }
                            .tag(t.rowId)
                            .listRowBackground(DecksTheme.surface)
                            .contextMenu { rowMenu(t) }
                    }
                }
                .scrollContentBackground(.hidden)
                .listStyle(.plain)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(DecksTheme.surface))
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder], allowsMultipleSelection: true) { result in
            if case let .success(urls) = result {
                for u in urls { library.addFolder(u) }
            }
        }
        .onChange(of: library.query) { library.refresh() }
        .onChange(of: library.selectedCrate) { library.refresh() }
        .alert("library.crate.new", isPresented: $askingCrate) {
            TextField("library.crate.name", text: $newCrate)
            Button("common.create") { library.createCrate(named: newCrate); newCrate = "" }
            Button("common.cancel", role: .cancel) { newCrate = "" }
        }
    }

    private var crateMenu: some View {
        Menu {
            Button { library.selectedCrate = nil } label: { Label("library.all_tracks", systemImage: library.selectedCrate == nil ? "checkmark" : "music.note") }
            ForEach(library.crates, id: \.id) { c in
                Button { library.selectedCrate = c.id } label: {
                    Label { Text(verbatim: c.name) } icon: { Image(systemName: library.selectedCrate == c.id ? "checkmark" : "shippingbox") }
                }
            }
            Divider()
            Button { askingCrate = true } label: { Label("library.crate.new", systemImage: "plus") }
            if let c = library.selectedCrate {
                Button(role: .destructive) { library.deleteCrate(c) } label: { Label("library.crate.delete", systemImage: "trash") }
            }
        } label: {
            Label("library.crates", systemImage: "shippingbox")
        }
        .accessibilityLabel(Text("library.crates"))
    }

    @ViewBuilder private func rowMenu(_ t: LibraryTrack) -> some View {
        Button { load(t, deck: 0) } label: { Label("library.load_a", systemImage: "a.square") }
        Button { load(t, deck: 1) } label: { Label("library.load_b", systemImage: "b.square") }
        if !library.crates.isEmpty {
            Menu("library.add_to_crate") {
                ForEach(library.crates, id: \.id) { c in
                    Button { library.add(t, toCrate: c.id) } label: { Text(verbatim: c.name) }
                }
            }
        }
    }

    private func load(_ t: LibraryTrack, deck: Int) {
        store.load(deck: deck, path: t.path)
        library.recordLoad(t, deck: deck)
    }
}

private struct TrackRow: View {
    let track: LibraryTrack
    let load: (Int) -> Void

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: track.title ?? URL(fileURLWithPath: track.path).deletingPathExtension().lastPathComponent)
                    .font(.subheadline.weight(.semibold)).foregroundStyle(DecksTheme.foreground).lineLimit(1)
                Text(verbatim: track.artist ?? "—").font(.caption).foregroundStyle(DecksTheme.muted).lineLimit(1)
            }
            Spacer()
            Text(verbatim: DecksFormat.bpm(track.bpm))
                .font(.system(.caption, design: .monospaced)).foregroundStyle(DecksTheme.foreground)
                .frame(width: 48, alignment: .trailing)
            Text(verbatim: track.key ?? "—")
                .font(.system(size: 11, weight: .bold))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Capsule().fill(DecksTheme.key(track.key)))
                .foregroundStyle(DecksTheme.accentForeground)
                .frame(width: 40)
            Text(verbatim: DecksFormat.time(track.durationSec ?? 0))
                .font(.system(.caption, design: .monospaced)).foregroundStyle(DecksTheme.muted)
                .frame(width: 44, alignment: .trailing)
            Button { load(0) } label: { Text("library.a").font(.caption.weight(.heavy)).frame(width: 26, height: 22) }
                .buttonStyle(.borderedProminent).tint(DecksTheme.deck(0))
                .accessibilityLabel(Text("library.load_a"))
            Button { load(1) } label: { Text("library.b").font(.caption.weight(.heavy)).frame(width: 26, height: 22) }
                .buttonStyle(.borderedProminent).tint(DecksTheme.deck(1))
                .accessibilityLabel(Text("library.load_b"))
        }
        .accessibilityElement(children: .combine)
    }
}

extension LibraryTrack {
    /// Stable list identity (id after the first scan, path before).
    var rowId: String { id ?? path }
}
