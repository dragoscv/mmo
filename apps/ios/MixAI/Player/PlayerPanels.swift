import MixaiCore
import SwiftUI
import UIKit

/// Search inside the subtitles of the playing title (server index, loaded tracks as fallback). Tap → seek.
struct SubtitleSearchSheet: View {
    let player: PlayerCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var outcome: SubtitleSearchOutcome?
    @State private var loading = false
    @State private var searchTask: Task<Void, Never>?
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let outcome {
                    if outcome.matches.isEmpty {
                        ContentUnavailableView {
                            Label("subsearch.empty_title", systemImage: "text.magnifyingglass")
                        } description: {
                            Text(outcome.localOnly ? LocalizedStringKey("subsearch.empty_local") : LocalizedStringKey("subsearch.empty_body"))
                        }
                    } else {
                        List {
                            if outcome.localOnly {
                                Text("subsearch.local_only").font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
                            }
                            ForEach(outcome.matches) { m in
                                Button {
                                    player.seekToMatch(m)
                                    dismiss()
                                } label: {
                                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                                        Text(formatClock(m.start)).font(Theme.body(13, weight: .semibold)).monospacedDigit()
                                            .foregroundStyle(Theme.primary)
                                        Text(m.text).font(Theme.body(15)).multilineTextAlignment(.leading)
                                    }
                                }
                                .accessibilityHint(Text("subsearch.jump_hint"))
                            }
                        }
                    }
                } else {
                    ContentUnavailableView {
                        Label("subsearch.title", systemImage: "captions.bubble")
                    } description: {
                        Text("subsearch.prompt")
                    }
                }
            }
            .navigationTitle(Text("subsearch.title"))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: Text("subsearch.placeholder"))
            .onSubmit(of: .search) { run() }
            .onChange(of: query) { _, q in
                searchTask?.cancel()
                guard q.trimmingCharacters(in: .whitespaces).count >= 3 else { return }
                searchTask = Task {
                    try? await Task.sleep(for: .milliseconds(400))
                    if !Task.isCancelled { run() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("action.close") { dismiss() }
                }
            }
        }
    }

    private func run() {
        let q = query
        guard !q.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        loading = true
        Task {
            let r = await player.searchSubtitles(q)
            if q == query {
                outcome = r
                loading = false
            }
        }
    }
}

/// Scene bookmarks of the playing title: mine + shared by the family. Tap → seek, swipe → delete (own only).
struct BookmarksSheet: View {
    let player: PlayerCoordinator
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var shared = false
    @State private var saving = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("bookmarks.label_placeholder", text: $label)
                        .textInputAutocapitalization(.sentences)
                        .submitLabel(.done)
                    Toggle("bookmarks.shared", isOn: $shared)
                    Button {
                        add()
                    } label: {
                        HStack {
                            Label("bookmarks.add_at \(formatClock(player.position))", systemImage: "bookmark.fill")
                            if saving { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(saving)
                } footer: {
                    Text("bookmarks.shared_footer")
                }
                if let err = player.bookmarkError {
                    Section {
                        Label(err, systemImage: "exclamationmark.triangle.fill").foregroundStyle(Theme.destructive)
                        Button("action.retry") { Task { await player.loadBookmarks() } }
                    }
                }
                Section {
                    if player.bookmarksLoading && player.bookmarks.isEmpty {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    } else if player.bookmarks.isEmpty {
                        Text("bookmarks.empty").foregroundStyle(Theme.mutedForeground)
                    } else {
                        ForEach(player.bookmarks) { b in
                            Button {
                                player.seekToBookmark(b)
                                dismiss()
                            } label: { row(b) }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if b.mine == true {
                                    Button(role: .destructive) {
                                        Task { await player.deleteBookmark(b) }
                                    } label: { Label("action.delete", systemImage: "trash") }
                                }
                            }
                        }
                    }
                } header: {
                    Text("player.bookmarks")
                }
            }
            .navigationTitle(Text("player.bookmarks"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("action.close") { dismiss() }
                }
            }
            .task { await player.loadBookmarks() }
            .refreshable { await player.loadBookmarks() }
        }
    }

    private func row(_ b: Bookmark) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(formatClock(b.sec)).font(Theme.body(13, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.primary)
            VStack(alignment: .leading, spacing: 2) {
                Text(b.label.isEmpty ? String(localized: "bookmarks.untitled") : b.label).font(Theme.body(15))
                HStack(spacing: 6) {
                    if b.mine != true, let name = b.profileName {
                        Text(name)
                    }
                    if b.shared {
                        Label("bookmarks.shared_badge", systemImage: "person.2.fill").labelStyle(.titleAndIcon)
                    }
                }
                .font(Theme.body(12)).foregroundStyle(Theme.mutedForeground)
            }
        }
    }

    private func add() {
        saving = true
        let l = label, s = shared
        Task {
            if await player.addBookmark(label: l, shared: s) {
                label = ""
            }
            saving = false
        }
    }
}

/// Second subtitle track (dual subtitles) for the OSD menu.
struct SecondarySubtitlePicker: View {
    let player: PlayerCoordinator

    var body: some View {
        Picker(selection: Binding(get: { player.secondarySubtitleOrdinal ?? -1 }, set: { player.selectSecondarySubtitle($0 < 0 ? nil : $0) })) {
            Text("player.subtitles_off").tag(-1)
            ForEach(player.subtitleTracks, id: \.ordinal) { s in
                Text(s.track.title ?? s.track.lang?.uppercased() ?? String(localized: "player.subtitle_n \(s.ordinal + 1)")).tag(s.ordinal)
            }
        } label: { Label("player.subtitles_second", systemImage: "captions.bubble.fill") }
        .pickerStyle(.menu)
    }
}

/// OSD "Play on TV" button: hands the session to the app-level Play-on sheet.
struct PlayOnTVButton: View {
    let player: PlayerCoordinator

    var body: some View {
        Button { player.playOnTV() } label: { Image(systemName: "tv") }
            .accessibilityLabel(Text("player.play_on"))
    }
}

/// Kid profile over its daily cap.
struct CapLockedView: View {
    let minutes: Int?
    let onClose: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "lock.fill").font(.system(size: 44)).foregroundStyle(Theme.primary)
            Text("cap.locked_title").font(Theme.heading(22)).multilineTextAlignment(.center)
            if let minutes {
                Text("cap.locked_body \(minutes)").font(Theme.body(15)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
            } else {
                Text("cap.locked_body_generic").font(Theme.body(15)).foregroundStyle(Theme.mutedForeground).multilineTextAlignment(.center)
            }
            Button("action.close", action: onClose).buttonStyle(.glassProminent)
        }
        .foregroundStyle(.white)
        .padding(28)
        .accessibilityElement(children: .contain)
    }
}

/// UIView libVLC draws into (VLC engine only; AVPlayer uses `VideoSurface`).
struct VLCSurface: UIViewRepresentable {
    let player: PlayerCoordinator
    let generation: Int

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .black
        player.attachSurface(v)
        context.coordinator.generation = generation
        return v
    }

    func updateUIView(_ v: UIView, context: Context) {
        if context.coordinator.generation != generation {
            context.coordinator.generation = generation
            player.attachSurface(v)
        }
    }

    func makeCoordinator() -> Gen { Gen() }

    final class Gen {
        var generation = 0
    }
}
