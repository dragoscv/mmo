import DecksFFI
import Foundation
import Observation
import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    /// `.mixaipack` skin / layout packs (declared in Info-iOS.plist / Info-macOS.plist).
    static let mixaiPack = UTType(exportedAs: "ro.mixai.mixaipack", conformingTo: .zip)
}

/// One layout the user can pick: built-in preset or `<packId>/<layoutId>` from an installed pack.
struct DecksLayoutChoice: Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    /// Canonical LayoutDoc JSON (what `layoutSolve` takes).
    let json: String
}

/// Skins, layouts and `.mixaipack` packs (WP19-34). Pack verification, storage and the zero-scroll
/// solver are the Rust ones (decks-ffi `PackStore`, `packInspect`, `layoutSolve`): no zip or
/// Ed25519 code in Swift. Packs live in `Application Support/packs`; the choice persists in
/// UserDefaults (`decks.skin.*`).
@MainActor
@Observable
final class AppearanceStore {
    /// One store for the app: RootView and the settings section (also the separate macOS Settings scene).
    static let shared = AppearanceStore()

    private let store: PackStore?
    private let defaults: UserDefaults

    private(set) var packs: [PackSummary] = []
    private(set) var layouts: [DecksLayoutChoice] = []
    /// Last import result for the settings row (pack name or the English rejection reason).
    var lastImport: Result<String, PackImportError>?

    private(set) var dark: Bool
    private(set) var accent: String
    /// Built-in layout id or `<packId>/<layoutId>`.
    private(set) var layoutId: String
    /// Installed skin pack whose colours apply (nil = none).
    private(set) var packId: String?

    private enum Keys {
        static let dark = "decks.skin.dark"
        static let accent = "decks.skin.accent"
        static let layout = "decks.skin.layout"
        static let pack = "decks.skin.pack"
    }

    init() {
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))?
            .appendingPathComponent("packs", isDirectory: true)
        if let dir { try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        let d = UserDefaults.standard
        store = dir.map { PackStore(dir: $0.path) }
        defaults = d
        dark = d.object(forKey: Keys.dark) as? Bool ?? true
        accent = d.string(forKey: Keys.accent) ?? "violet"
        layoutId = d.string(forKey: Keys.layout) ?? "classic"
        packId = d.string(forKey: Keys.pack)
        // Built-in presets and the saved skin are available at once (no pack verification needed);
        // the installed packs are listed off the main actor.
        layouts = Self.parse(layoutPresetsJson())
        persistAndApply()
        reload()
    }

    func setDark(_ v: Bool) { dark = v; persistAndApply() }
    func setAccent(_ v: String) { accent = v; persistAndApply() }
    func setPack(_ id: String?) { packId = id; persistAndApply() }
    func setLayout(_ id: String) {
        layoutId = id
        defaults.set(id, forKey: Keys.layout)
    }

    /// Re-read installed packs + layouts and re-apply the palette (the listing runs off the main
    /// actor: `PackStore.list()` re-verifies every archive, Ed25519 included).
    func reload() {
        Task { await reloadAsync() }
    }

    /// `reload()` for callers that must wait for the new list (install, pack opened from Files).
    func reloadAsync() async {
        guard let store else {
            apply(packs: [], extraLayouts: nil)
            return
        }
        let listed = await Task.detached { () -> ([PackSummary], String) in
            return (store.list(), store.layoutsJson())
        }.value
        apply(packs: listed.0, extraLayouts: listed.1)
    }

    private func apply(packs listed: [PackSummary], extraLayouts: String?) {
        packs = listed
        var all = Self.parse(layoutPresetsJson())
        if let extraLayouts { all += Self.parse(extraLayouts) }
        layouts = all
        if let p = packId, !listed.contains(where: { $0.id == p }) { packId = nil }
        persistAndApply()
    }

    /// The layout to show: exact id, else a unique pack-local match (Decks 1.3 stored bare ids), else classic.
    var currentLayout: DecksLayoutChoice? {
        if let l = layouts.first(where: { $0.id == layoutId }) { return l }
        let hits = layouts.filter { $0.id.contains("/") && $0.id.split(separator: "/").last.map(String.init) == layoutId }
        if hits.count == 1 { return hits[0] }
        return layouts.first { $0.id == "classic" } ?? layouts.first
    }

    var skinPacks: [PackSummary] { packs.filter { $0.kind == "skin" || $0.kind == "bundle" } }

    /// Verify + install a `.mixaipack` picked with `fileImporter` (security-scoped URL).
    func importPack(from url: URL) {
        Task { _ = await install(from: url) }
    }

    /// Install a pack and apply it; the reading, verification and storage all run off the main
    /// actor. Returns the pack name or the (English) rejection reason, and records it in
    /// `lastImport` either way.
    @discardableResult
    func install(from url: URL) async -> Result<String, PackImportError> {
        guard let store else {
            let e = PackImportError(reason: "no pack folder")
            lastImport = .failure(e)
            return .failure(e)
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let outcome = await Task.detached { () -> Result<PackSummary, PackImportError> in
            do {
                let size = (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                // decks-packs MAX_ARCHIVE_BYTES (25 MB): never read an unbounded file.
                guard size <= 25 * 1024 * 1024 else { throw PackImportError(reason: "pack is larger than 25 MB") }
                let info = try store.install(bytes: Data(contentsOf: url))
                return .success(info)
            } catch let e as PackImportError {
                return .failure(e)
            } catch {
                return .failure(PackImportError(reason: AppearanceStore.reason(error)))
            }
        }.value
        switch outcome {
        case let .success(info):
            // Select the new skin BEFORE reloading: the reload re-applies the palette, so a pack
            // chosen afterwards would only take effect at the next change.
            if info.kind == "skin" || info.kind == "bundle" { packId = info.id }
            await reloadAsync()
            lastImport = .success(info.name)
            return .success(info.name)
        case let .failure(e):
            lastImport = .failure(e)
            return .failure(e)
        }
    }

    func remove(_ id: String) {
        try? store?.remove(id: id)
        if packId == id { packId = nil }
        reload()
    }

    private func persistAndApply() {
        defaults.set(dark, forKey: Keys.dark)
        defaults.set(accent, forKey: Keys.accent)
        defaults.set(packId, forKey: Keys.pack)
        let pack = packs.first { $0.id == packId }
        var overrides: [String: Color] = [:]
        for c in pack?.colors ?? [] { overrides[c.key] = Color(rgb24: c.rgb, opacity: Double(c.alpha)) }
        let mode = pack?.mode.map { $0 == "dark" } ?? dark
        DecksPalette.shared.apply(dark: mode, accent: accent, overrides: overrides)
    }

    /// LayoutDoc JSON array → choices (each keeps its own canonical JSON for the solver).
    static func parse(_ json: String) -> [DecksLayoutChoice] {
        guard let data = json.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
        return arr.compactMap { o in
            guard let id = o["id"] as? String, let name = o["name"] as? String,
                  let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]),
                  let s = String(data: d, encoding: .utf8) else { return nil }
            return DecksLayoutChoice(id: id, name: name, json: s)
        }
    }

    /// Every DecksError case carries one `reason` field; read it without naming the cases.
    nonisolated static func reason(_ error: Error) -> String {
        let payload = Mirror(reflecting: error).children.first?.value
        let reason = payload.flatMap { Mirror(reflecting: $0).children.first { $0.label == "reason" }?.value as? String }
        return reason ?? error.localizedDescription
    }
}

struct PackImportError: Error, Equatable, Sendable {
    let reason: String
}
