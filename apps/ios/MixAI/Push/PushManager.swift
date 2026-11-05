import BackgroundTasks
import Foundation
import MixaiCore
import Observation
import UIKit
import UserNotifications

/// `@unchecked Sendable` carrier for framework objects handed to a @Sendable callback and used only on the main actor.
struct MainActorBox<T>: @unchecked Sendable {
    let value: T
}

/// App delegate: push token, notification taps/actions, background URLSession events, BGTaskScheduler, Sentry.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Telemetry.start()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories(PushManager.categories)
        // Must be registered before launch completes (BGTaskScheduler contract).
        BGTaskScheduler.shared.register(forTaskWithIdentifier: OfflineStore.smartTaskId, using: nil) { @Sendable task in
            let box = MainActorBox(value: task)
            Task { @MainActor in AppModel.shared.offline.runSmartTask(box.value) }
        }
        OfflineStore.scheduleSmartTask()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        AppModel.shared.push.didRegister(token: apnsTokenHex(deviceToken), app: AppModel.shared)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        AppModel.shared.push.didFail(error.localizedDescription)
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == OfflineStore.sessionId else { completionHandler(); return }
        AppModel.shared.offline.backgroundEventsHandler = completionHandler
        AppModel.shared.offline.ensureSession()
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        OfflineStore.scheduleSmartTask()
    }

    // MARK: UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let url = info["url"] as? String
        let fileId = info["fileId"] as? String
        let title = (info["title"] as? String) ?? response.notification.request.content.title
        let action = response.actionIdentifier
        await MainActor.run {
            AppModel.shared.handleNotification(action: action, url: url, fileId: fileId, title: title)
        }
    }
}

/// Notification permission + APNs token → `POST /api/push/register` on the MixAI web origin (only when signed in).
@MainActor
@Observable
final class PushManager {
    enum Status: Equatable { case unknown, denied, notSignedIn, registering, registered, unavailable, failed(String) }

    var status: Status = .unknown
    var authorized = false
    private(set) var token: String? = UserDefaults.standard.string(forKey: "apnsToken")
    /// ActivityKit push-to-start token (hex), sent along so the relay can start Live Activities remotely.
    var liveActivityToken: String?

    static var categories: Set<UNNotificationCategory> {
        let play = UNNotificationAction(identifier: "PLAY", title: String(localized: "push.action.play"), options: [.foreground])
        let download = UNNotificationAction(identifier: "DOWNLOAD", title: String(localized: "push.action.download"), options: [.foreground])
        let open = UNNotificationAction(identifier: "OPEN", title: String(localized: "push.action.open"), options: [.foreground])
        let join = UNNotificationAction(identifier: "JOIN", title: String(localized: "push.action.join"), options: [.foreground])
        return [
            UNNotificationCategory(identifier: "NEW_EPISODE", actions: [play, download], intentIdentifiers: []),
            UNNotificationCategory(identifier: "RECORDING", actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: "TOGETHER_INVITE", actions: [join], intentIdentifiers: []),
        ]
    }

    var statusText: LocalizedStringResource {
        switch status {
        case .unknown: "push.status.unknown"
        case .denied: "push.status.denied"
        case .notSignedIn: "push.status.not_signed_in"
        case .registering: "push.status.registering"
        case .registered: "push.status.registered"
        case .unavailable: "push.status.unavailable"
        case .failed(let m): "push.status.failed \(m)"
        }
    }

    /// Reads the current permission; re-registers with APNs when already allowed (tokens can rotate).
    func refresh(app: AppModel) async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        authorized = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
        if settings.authorizationStatus == .denied { status = .denied; return }
        if authorized { UIApplication.shared.registerForRemoteNotifications() }
        if !app.accountStore.signedIn { status = .notSignedIn }
    }

    func requestAuthorization(app: AppModel) async {
        do {
            authorized = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            authorized = false
        }
        if authorized {
            UIApplication.shared.registerForRemoteNotifications()
        } else {
            status = .denied
        }
    }

    func didRegister(token hex: String, app: AppModel) {
        token = hex
        UserDefaults.standard.set(hex, forKey: "apnsToken")
        Task { await register(app: app) }
    }

    func didFail(_ message: String) { status = .failed(message) }

    /// Sends the current token (+ active profile, + push-to-start token) to the relay. No-op when signed out.
    func register(app: AppModel) async {
        guard let token else { return }
        guard let session = app.accountStore.sessionToken else { status = .notSignedIn; return }
        status = .registering
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        let reg = PushRegistration(token: token, environment: pushEnvironment(embeddedProfile: profile), deviceName: ClientIdentity.current.deviceName,
                                   profileId: app.activeProfile?.id, liveActivityToken: liveActivityToken)
        do {
            try await AccountAPI(origin: app.origin).registerPush(reg, session: session)
            status = .registered
        } catch let e as AccountError {
            status = e.code == "push_unavailable" ? .unavailable : (e.code == "unauthorized" ? .notSignedIn : .failed(e.code))
        } catch {
            status = .failed(error.localizedDescription)
        }
    }

    /// Best-effort on sign-out / account deletion.
    func unregister(app: AppModel, session: String) async {
        guard let token else { return }
        try? await AccountAPI(origin: app.origin).unregisterPush(token: token, session: session)
        status = .notSignedIn
    }
}
