import Foundation

/// Result of [ProfileStore.unlock].
public enum UnlockResult: Sendable, Equatable {
    case ok(Profile)
    /// Wrong PIN; tries left before the 5-minute lock (nil when unknown).
    case wrongPin(triesLeft: Int?)
    /// Too many wrong PINs.
    case locked(retryAfterMs: Int)
    case failed(String)
}

/// Persisted active profile + 12 h unlock token.
public struct SavedProfile: Codable, Sendable, Equatable {
    public var id: String
    public var token: String
    public var expiresAt: Int

    public init(id: String = "", token: String = "", expiresAt: Int = 0) {
        self.id = id
        self.token = token
        self.expiresAt = expiresAt
    }

    public func tokenValid(nowMs: Int) -> Bool { !token.isEmpty && expiresAt > nowMs }
}

/// Viewer profiles owned by MMO Server (`/media/profiles*`, port of `ProfileRepository`).
public actor ProfileStore {
    private let client: MmoClient
    private let load: @Sendable () -> SavedProfile
    private let save: @Sendable (SavedProfile) -> Void
    private let now: @Sendable () -> Int

    public private(set) var profiles: [Profile] = []
    public private(set) var active: Profile?
    private var token = ""
    private var tokenExp = 0

    public init(
        client: MmoClient,
        load: @escaping @Sendable () -> SavedProfile,
        save: @escaping @Sendable (SavedProfile) -> Void,
        now: @escaping @Sendable () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.client = client
        self.load = load
        self.save = save
        self.now = now
    }

    public var activeId: String { active?.id ?? "default" }

    private func applyToken(_ t: String, _ exp: Int) {
        token = t
        tokenExp = exp
        client.setProfileToken(exp > now() ? t : "")
    }

    @discardableResult
    public func refresh() async throws -> [Profile] {
        let page = try await client.get(ProfilesPage.self, "/media/profiles")
        profiles = page.profiles.sorted { ($0.sort, $0.createdAt) < ($1.sort, $1.createdAt) }
        if let a = active { active = profiles.first { $0.id == a.id } ?? a }
        return profiles
    }

    /// Restores the persisted profile; true when usable without a PIN prompt.
    public func restore() async -> Bool {
        let saved = load()
        if (try? await refresh()) == nil, profiles.isEmpty { return false }
        guard let p = profiles.first(where: { $0.id == saved.id }) else { return false }
        if saved.tokenValid(nowMs: now()) { applyToken(saved.token, saved.expiresAt) }
        active = p
        return !p.hasPin || saved.tokenValid(nowMs: now())
    }

    /// True when startup must show the picker (several profiles, or the only one needs its PIN).
    public func needsPicker() async -> Bool {
        let restoredOk = await restore()
        if profiles.count > 1 { return true }
        guard let only = profiles.first else { return false }
        if only.hasPin && !restoredOk { return true }
        if active == nil { select(only) }
        return false
    }

    /// Selects a profile without PIN (or with a still-valid token).
    public func select(_ p: Profile) {
        let keep = p.id == active?.id && tokenExp > now()
        if !keep { applyToken("", 0) }
        active = p
        save(SavedProfile(id: p.id, token: token, expiresAt: tokenExp))
    }

    /// `POST /media/profiles/{id}/unlock` with an optional 4-digit PIN.
    public func unlock(_ p: Profile, pin: String?) async -> UnlockResult {
        let body = pin.map { "{\"pin\":\"\($0)\"}" } ?? "{}"
        do {
            let data = try await client.request("POST", "/media/profiles/\(MmoClient.enc(p.id))/unlock", body: Data(body.utf8))
            let res = try JSON.decoder.decode(ProfileUnlock.self, from: data)
            applyToken(res.token, res.expiresAt)
            active = p
            save(SavedProfile(id: p.id, token: res.token, expiresAt: res.expiresAt))
            return .ok(p)
        } catch let e as APIStatusError {
            let err = try? JSON.decoder.decode(ProfileUnlockError.self, from: Data(e.body.utf8))
            switch e.status {
            case 401: return .wrongPin(triesLeft: err?.triesLeft)
            case 429: return .locked(retryAfterMs: err?.retryAfterMs ?? 300_000)
            default: return .failed(e.description)
            }
        } catch {
            return .failed(error.localizedDescription)
        }
    }

    public func signOut() {
        active = nil
        applyToken("", 0)
        save(SavedProfile())
    }
}

/// Pure PIN pad model (4 digits).
public struct PinPad: Sendable, Equatable {
    public private(set) var digits: String = ""
    public static let length = 4
    public init() {}

    /// Appends a digit; returns the full PIN when it reaches 4 digits.
    public mutating func press(_ d: Int) -> String? {
        guard (0...9).contains(d), digits.count < Self.length else { return nil }
        digits.append(String(d))
        return digits.count == Self.length ? digits : nil
    }

    public mutating func backspace() { if !digits.isEmpty { digits.removeLast() } }
    public mutating func clear() { digits = "" }
}
