import Foundation
#if canImport(Sentry)
import Sentry
#endif

/// Crash + error reporting (Sentry). DSN from Info.plist `SentryDSN`; empty or absent → no-op. No PII.
enum Telemetry {
    @MainActor
    static func start() {
        #if canImport(Sentry)
        guard let dsn = Bundle.main.object(forInfoDictionaryKey: "SentryDSN") as? String, !dsn.isEmpty else { return }
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        // TestFlight builds carry a sandbox receipt; App Store builds a production one.
        let isTestFlight = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
        SentrySDK.start { o in
            o.dsn = dsn
            o.sendDefaultPii = false
            o.tracesSampleRate = 0.1
            o.environment = isTestFlight ? "testflight" : "production"
            o.releaseName = "ro.mixai.app@\(version)+\(build)"
        }
        #endif
    }
}
