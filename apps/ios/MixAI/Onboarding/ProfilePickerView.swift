import MixaiCore
import SwiftUI

/// "Who's watching?" — shared grid + PIN pad (MixaiUI) wired to the app's profile store.
struct ProfilePickerView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ProfileGridView(profiles: app.profiles) { p in
            Task { await app.choose(p) }
        } unlock: { p, pin in
            guard let ps = app.profileStore else { return .failed("") }
            return await ps.unlock(p, pin: pin)
        } onUnlocked: { p in
            app.unlocked(p)
        } reload: {
            if let ps = app.profileStore { app.profiles = (try? await ps.refresh()) ?? [] }
        }
        .task {
            #if DEBUG
            // Simulator checks: SIMCTL_CHILD_MIXAI_PROFILE=<name> picks a profile without a PIN.
            if let name = ProcessInfo.processInfo.environment["MIXAI_PROFILE"], let p = app.profiles.first(where: { $0.name == name }), !p.hasPin {
                await app.choose(p)
            }
            #endif
        }
    }
}
