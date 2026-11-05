import Foundation
import Synchronization

/// Who talks to the MMO Server / mixai.ro (port of tv-android `ClientIdentity`). Set once at launch.
public struct ClientIdentity: Sendable, Hashable {
    /// `platform` sent on pairing, device-code sign-in and hub `hello`.
    public let platform: String
    public let appVersion: String
    /// Device name when the user did not pick one.
    public let deviceName: String
    /// HTTP User-Agent product token.
    public let userAgentPrefix: String

    public init(platform: String, appVersion: String, deviceName: String, userAgentPrefix: String) {
        self.platform = platform
        self.appVersion = appVersion
        self.deviceName = deviceName
        self.userAgentPrefix = userAgentPrefix
    }

    public var userAgent: String { "\(userAgentPrefix)/\(appVersion)" }
    /// Hub `hello.app`, e.g. `mixai-ios/1.0.0`.
    public var appTag: String { "\(userAgentPrefix.lowercased())/\(appVersion)" }

    private static let storage = Mutex(ClientIdentity(platform: "ios", appVersion: "0.0.0", deviceName: "iPhone", userAgentPrefix: "MixAI-iOS"))

    /// Process-wide identity; the default only serves unit tests.
    public static var current: ClientIdentity {
        get { storage.withLock { $0 } }
        set { storage.withLock { $0 = newValue } }
    }
}
