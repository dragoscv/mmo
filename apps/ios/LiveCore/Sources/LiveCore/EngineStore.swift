import Foundation
import Observation
import Security

/// Engine tokens in the Keychain (generic passwords, this device only, readable after first unlock so a reconnect
/// in the background works). Account = `PairedEngine.id`.
public struct TokenVault: Sendable {
    public let service: String

    public init(service: String = "ro.mixai.live.tokens") { self.service = service }

    public func set(_ token: String, for id: String) {
        delete(id)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(token.utf8),
        ]
        SecItemAdd(q as CFDictionary, nil)
    }

    public func get(_ id: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: id,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public func delete(_ id: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: id]
        SecItemDelete(q as CFDictionary)
    }
}

/// Pure list operations for paired engines (tested without the Keychain).
public enum PairedList {
    /// Insert or update by endpoint (re-pairing the same host:port replaces the old entry); newest first.
    public static func upsert(_ list: [PairedEngine], _ e: PairedEngine) -> (list: [PairedEngine], id: String) {
        var out = list
        var e = e
        if let i = out.firstIndex(where: { $0.endpoint == e.endpoint || $0.id == e.id }) {
            e.id = out[i].id
            out.remove(at: i)
        }
        out.insert(e, at: 0)
        return (out, e.id)
    }

    /// Mark connected now and move to the front (auto-connect picks the first).
    public static func touch(_ list: [PairedEngine], id: String, role: Role?, name: String?, at date: Date) -> [PairedEngine] {
        guard let i = list.firstIndex(where: { $0.id == id }) else { return list }
        var out = list
        var e = out.remove(at: i)
        e.lastConnected = date
        if let role { e.role = role }
        if let name, !name.isEmpty { e.name = name }
        out.insert(e, at: 0)
        return out
    }
}

/// Paired engines: metadata in UserDefaults, tokens in the Keychain.
@MainActor @Observable
public final class EngineStore {
    public private(set) var engines: [PairedEngine] = []

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let vault: TokenVault
    @ObservationIgnored private let key = "mixaiLivePairedEngines"

    public init(defaults: UserDefaults = .standard, vault: TokenVault = TokenVault()) {
        self.defaults = defaults
        self.vault = vault
        if let data = defaults.data(forKey: key), let list = try? JSONDecoder().decode([PairedEngine].self, from: data) {
            engines = list.filter { vault.get($0.id) != nil }
        }
    }

    @discardableResult
    public func save(_ link: PairingLink) -> PairedEngine {
        let e = PairedEngine(name: link.name ?? link.endpoint.host, endpoint: link.endpoint)
        let (list, id) = PairedList.upsert(engines, e)
        vault.set(link.token, for: id)
        engines = list
        persist()
        return list[0]
    }

    public func token(for e: PairedEngine) -> String? { vault.get(e.id) }

    public func touch(_ id: String, role: Role?, name: String?) {
        engines = PairedList.touch(engines, id: id, role: role, name: name, at: .now)
        persist()
    }

    public func remove(_ e: PairedEngine) {
        vault.delete(e.id)
        engines.removeAll { $0.id == e.id }
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(engines) { defaults.set(data, forKey: key) }
    }
}
