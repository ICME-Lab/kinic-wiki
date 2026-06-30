// Where: mobile/ios/KinicApp/KinicApp.swift
// What: SwiftUI entry point for the Kinic iOS app.
// Why: The app owns login, settings, and pending Share Extension captures.

import SwiftUI

@main
struct KinicApp: App {
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            HomeView(model: model)
                .tint(KinicDesign.hotPink)
                .onOpenURL { _ in
                    model.refreshInbox()
                    model.autoSubmitPendingURL()
                }
        }
    }
}
