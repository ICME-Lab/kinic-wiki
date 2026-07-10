// Where: mobile/ios/KinicApp/KinicApp.swift
// What: SwiftUI entry point for the Kinic iOS app.
// Why: The app owns login, settings, and pending Share Extension captures.

import SwiftUI

@main
struct KinicApp: App {
    @State private var model = AppModel.live()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            HomeView(model: model)
                .tint(KinicDesign.hotPink)
                .preferredColorScheme(model.isDarkAppearanceEnabled ? .dark : .light)
                .task {
                    model.startDatabaseCreditTransactionObserver()
                    model.startRecoverPendingDatabaseCreditPurchases()
                }
                .onOpenURL { url in
                    model.handleOpenURL(url)
                }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        model.appDidBecomeActive()
                    }
                }
        }
    }
}
