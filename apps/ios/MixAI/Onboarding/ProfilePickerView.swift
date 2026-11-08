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
    }
}
