import AuthenticationServices
import Foundation
import MixaiCore
import Observation
import SwiftUI
import UIKit

/// Sendable copy of what the server needs from an Apple credential.
struct AppleCredentialPayload: Sendable {
    let identityToken: String?
    let authorizationCode: String?
    let givenName: String?
    let familyName: String?
    let canceled: Bool
    let errorText: String?

    init(_ result: Result<ASAuthorization, any Error>) {
        switch result {
        case .success(let auth):
            let cred = auth.credential as? ASAuthorizationAppleIDCredential
            identityToken = cred?.identityToken.flatMap { String(data: $0, encoding: .utf8) }
            authorizationCode = cred?.authorizationCode.flatMap { String(data: $0, encoding: .utf8) }
            givenName = cred?.fullName?.givenName
            familyName = cred?.fullName?.familyName
            canceled = false
            errorText = nil
        case .failure(let e):
            identityToken = nil
            authorizationCode = nil
            givenName = nil
            familyName = nil
            canceled = (e as? ASAuthorizationError)?.code == .canceled
            errorText = e.localizedDescription
        }
    }
}

/// MixAI account (web origin): native Sign in with Apple, Google through the web device-code flow, sign-out and
/// in-app deletion. Session token in the Keychain, the public user record in UserDefaults.
@MainActor
@Observable
final class AccountStore {
    static let keychainKey = "mixai-session"
    private static let userKey = "accountUser"

    private(set) var user: AccountUser?
    private(set) var signedIn = false
    var busy = false
    var error: String?
    /// Device code shown while the Google web sheet is open (fallback when the sheet is closed early).
    private(set) var webCode: String?

    @ObservationIgnored private var webSession: ASWebAuthenticationSession?
    private let anchor = WebAuthAnchor()
    @ObservationIgnored private var webClosed = false

    var sessionToken: String? { Keychain.get(Self.keychainKey) }

    /// Boot: restore the stored session (no network).
    func restore(app: AppModel) {
        guard let tok = sessionToken, !tok.isEmpty else { return }
        user = UserDefaults.standard.data(forKey: Self.userKey).flatMap { try? JSON.decoder.decode(AccountUser.self, from: $0) }
        signedIn = true
        if app.account == nil, let u = user { app.account = Self.sessionUser(u) }
    }

    // MARK: Sign in with Apple

    /// Completion of SwiftUI `SignInWithAppleButton` (nonce from its request; the RAW nonce goes to the server).
    func complete(_ p: AppleCredentialPayload, nonce: AppleNonce?, app: AppModel) async {
        if p.canceled { return }
        if let e = p.errorText { error = e; return }
        guard let idToken = p.identityToken, let nonce else {
            error = String(localized: "account.error.generic")
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let s = try await AccountAPI(origin: app.origin).signInWithApple(identityToken: idToken, nonce: nonce.raw, authorizationCode: p.authorizationCode,
                                                                             givenName: p.givenName, familyName: p.familyName)
            store(token: s.sessionToken, user: s.user, app: app)
        } catch let e as AccountError {
            error = Self.message(e)
        } catch {
            self.error = error.localizedDescription
        }
    }

    // MARK: Google (web) — device code approved in an in-app browser sheet

    func signInWithGoogleWeb(app: AppModel) async {
        let auth = DeviceAuth(origin: app.origin)
        busy = true
        error = nil
        webClosed = false
        defer { busy = false; webCode = nil; webSession = nil }
        do {
            let c = try await auth.requestCode(deviceName: ClientIdentity.current.deviceName)
            webCode = c.user_code
            var comps = URLComponents(string: app.origin + "/activate")
            comps?.queryItems = [URLQueryItem(name: "code", value: c.user_code)]
            guard let url = comps?.url else { return }
            let session = ASWebAuthenticationSession(url: url, callback: .customScheme("mixai")) { @Sendable _, _ in
                Task { @MainActor in AppModel.shared.accountStore.webSheetClosed() }
            }
            session.presentationContextProvider = anchor
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            _ = session.start()
            var interval = max(2, c.interval ?? 5)
            let deadline = Date().addingTimeInterval(TimeInterval(c.expires_in ?? 900))
            // Keep polling ~60 s after the sheet closes (the user may approve on another device with the code).
            var closedAt: Date?
            while !Task.isCancelled && Date() < deadline {
                try await Task.sleep(for: .seconds(interval))
                if webClosed {
                    closedAt = closedAt ?? .now
                    if let at = closedAt, Date().timeIntervalSince(at) > 60 { return }
                }
                switch try await auth.pollToken(deviceCode: c.device_code) {
                case .pending: continue
                case .slowDown: interval += 5
                case .accessDenied: error = String(localized: "signin.denied"); session.cancel(); return
                case .expired: error = String(localized: "pair.expired"); session.cancel(); return
                case .ok(let ok):
                    session.cancel()
                    adopt(ok, app: app)
                    if app.server == nil, let (comp, base) = await auth.pickReachable(ok.companions ?? []) {
                        await app.connect(ServerConnection(name: comp.name ?? "MixAI Server", baseURL: base), token: comp.token)
                    }
                    return
                }
            }
        } catch is CancellationError {
            webSession?.cancel()
        } catch let e as DeviceAuthError {
            error = e.kind == .network ? String(localized: "signin.network \(e.host)") : String(localized: "signin.status \(e.status)")
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func webSheetClosed() { webClosed = true }

    /// Device-code approval (onboarding SignInView or the Google web sheet) → account session.
    func adopt(_ ok: DeviceTokenOk, app: AppModel) {
        let u = AccountUser(id: ok.user.id, name: ok.user.name, email: nil, image: ok.user.image)
        store(token: ok.session_token, user: u, app: app)
        app.account = ok.user
    }

    // MARK: sign out / delete

    func signOut(app: AppModel) async {
        if let s = sessionToken { await app.push.unregister(app: app, session: s) }
        clear(app: app)
    }

    /// `DELETE /api/account` (App Store 5.1.1(v)); `confirmation` must be "DELETE".
    @discardableResult
    func deleteAccount(confirmation: String, app: AppModel) async -> Bool {
        guard let s = sessionToken else { return false }
        busy = true
        error = nil
        defer { busy = false }
        await app.push.unregister(app: app, session: s)
        do {
            try await AccountAPI(origin: app.origin).deleteAccount(confirmation: confirmation, session: s)
            clear(app: app)
            return true
        } catch let e as AccountError {
            error = Self.message(e)
        } catch {
            self.error = error.localizedDescription
        }
        return false
    }

    private func store(token: String, user u: AccountUser, app: AppModel) {
        Keychain.set(token, for: Self.keychainKey)
        UserDefaults.standard.set(try? JSON.encoder.encode(u), forKey: Self.userKey)
        user = u
        signedIn = true
        app.account = Self.sessionUser(u)
        Task { await app.push.register(app: app) }
    }

    private func clear(app: AppModel) {
        Keychain.delete(Self.keychainKey)
        UserDefaults.standard.removeObject(forKey: Self.userKey)
        user = nil
        signedIn = false
        app.account = nil
    }

    /// `SessionUser` has no public memberwise init: round-trip through JSON.
    static func sessionUser(_ u: AccountUser) -> SessionUser? {
        let v = JSONValue.object(["id": .string(u.id), "name": u.name.map(JSONValue.string) ?? .null, "image": u.image.map(JSONValue.string) ?? .null])
        guard let data = try? JSON.encoder.encode(v) else { return nil }
        return try? JSON.decoder.decode(SessionUser.self, from: data)
    }

    static func message(_ e: AccountError) -> String {
        switch e.code {
        case "network": String(localized: "account.error.network")
        case "link_conflict": String(localized: "account.error.link_conflict")
        case "email_required": String(localized: "account.error.email_required")
        case "rate_limited": String(localized: "account.error.rate_limited")
        case "provider_unavailable": String(localized: "account.error.unavailable")
        default: String(localized: "account.error.code \(e.code)")
        }
    }
}

/// Key window as the anchor for the web sign-in sheet.
final class WebAuthAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            if let w = scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? scenes.first?.windows.first { return w }
            if let scene = scenes.first { return ASPresentationAnchor(windowScene: scene) }
            preconditionFailure("web sign-in started without a window scene")
        }
    }
}

/// SwiftUI Sign in with Apple button wired to `AccountStore` (nonce per request).
struct AppleSignInButton: View {
    @State private var nonce: AppleNonce?

    var body: some View {
        SignInWithAppleButton(.signIn) { request in
            let n = AppleNonce.random()
            nonce = n
            request.requestedScopes = [.fullName, .email]
            request.nonce = n.hashed
        } onCompletion: { result in
            let payload = AppleCredentialPayload(result)
            let n = nonce
            Task { @MainActor in await AppModel.shared.accountStore.complete(payload, nonce: n, app: AppModel.shared) }
        }
        .signInWithAppleButtonStyle(.white)
        .frame(height: 50)
        .clipShape(.capsule)
    }
}
