import SwiftUI

/// MixAI Decks for macOS, iPadOS and iOS (tracker WP19-15, ADR-0014 D61): SwiftUI shell over the Rust core
/// (decks-ffi). One source tree, two targets (`MixAIDecks` iOS/iPadOS, `MixAIDecksMac` macOS).
@main
struct DecksApp: App {
    @State private var store = DecksStore()
    @State private var library = LibraryStore()
    @State private var cursor = BrowserCursor()
    @State private var midi = MidiManager()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(library)
                .environment(cursor)
                .environment(midi)
                .preferredColorScheme(.dark)
                .tint(DecksTheme.accent)
                .task {
                    store.startEngine()
                    midi.start(store: store, dispatcher: MidiDispatcher(store: store, library: library, browser: cursor))
                }
        }
        #if os(macOS)
        .defaultSize(width: 1280, height: 820)
        #endif
        .commands { DecksCommands(store: store, library: library, cursor: cursor) }

        #if os(macOS)
        Settings {
            SettingsView()
                .environment(store)
                .environment(library)
                .environment(midi)
                .preferredColorScheme(.dark)
                .frame(width: 520, height: 460)
        }
        #endif
    }
}

/// Keyboard shortcuts (macOS menu bar, iPad hardware keyboard via the ⌘ overlay).
struct DecksCommands: Commands {
    let store: DecksStore
    let library: LibraryStore
    let cursor: BrowserCursor

    var body: some Commands {
        CommandMenu(Text("menu.deck_a")) { deckCommands(0, play: "z", cue: "x", sync: "c") }
        CommandMenu(Text("menu.deck_b")) { deckCommands(1, play: "m", cue: ",", sync: ".") }
        CommandMenu(Text("menu.library")) {
            Button("library.load_a") { loadSelected(0) }.keyboardShortcut(.leftArrow, modifiers: [.command, .shift])
            Button("library.load_b") { loadSelected(1) }.keyboardShortcut(.rightArrow, modifiers: [.command, .shift])
            Button("library.next") { cursor.move(by: 1, in: library.tracks) }.keyboardShortcut(.downArrow, modifiers: .option)
            Button("library.previous") { cursor.move(by: -1, in: library.tracks) }.keyboardShortcut(.upArrow, modifiers: .option)
        }
    }

    @ViewBuilder private func deckCommands(_ d: Int, play: Character, cue: Character, sync: Character) -> some View {
        Button("deck.play") { store.togglePlay(d) }.keyboardShortcut(KeyEquivalent(play), modifiers: [])
        Button("deck.cue") { store.cue(d, pressed: true); store.cue(d, pressed: false) }.keyboardShortcut(KeyEquivalent(cue), modifiers: [])
        Button("deck.sync") { store.syncTap(d) }.keyboardShortcut(KeyEquivalent(sync), modifiers: [])
        Divider()
        ForEach(0..<4, id: \.self) { slot in
            Button(hotCueTitle(slot)) { store.hotCue(d, slot: slot) }
                .keyboardShortcut(KeyEquivalent(Character(String(slot + 1 + d * 4))), modifiers: [])
        }
        Divider()
        Button("deck.loop") { store.loopToggleAuto(d) }.keyboardShortcut(KeyEquivalent(d == 0 ? "a" : "j"), modifiers: [])
        Button("deck.loop.halve") { store.loopHalve(d) }.keyboardShortcut(KeyEquivalent(d == 0 ? "q" : "u"), modifiers: [])
        Button("deck.loop.double") { store.loopDouble(d) }.keyboardShortcut(KeyEquivalent(d == 0 ? "w" : "i"), modifiers: [])
        Button("deck.jump.back") { store.beatJump(d, forward: false) }.keyboardShortcut(KeyEquivalent(d == 0 ? "s" : "k"), modifiers: [])
        Button("deck.jump.forward") { store.beatJump(d, forward: true) }.keyboardShortcut(KeyEquivalent(d == 0 ? "d" : "l"), modifiers: [])
        Button("deck.keylock") { store.toggleKeyLock(d) }.keyboardShortcut(KeyEquivalent(d == 0 ? "e" : "o"), modifiers: [])
        Button("deck.slip") { store.toggleSlip(d) }.keyboardShortcut(KeyEquivalent(d == 0 ? "r" : "p"), modifiers: [])
    }

    private func hotCueTitle(_ slot: Int) -> LocalizedStringKey {
        let keys: [LocalizedStringKey] = ["deck.hotcue.1", "deck.hotcue.2", "deck.hotcue.3", "deck.hotcue.4"]
        return keys[slot]
    }

    private func loadSelected(_ deck: Int) {
        guard let t = cursor.current(in: library.tracks) else { return }
        store.load(deck: deck, path: t.path)
        library.recordLoad(t, deck: deck)
    }
}
