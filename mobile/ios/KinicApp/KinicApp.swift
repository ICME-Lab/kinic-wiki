// Where: mobile/ios/KinicApp/KinicApp.swift
// What: SwiftUI entry point for the Kinic iOS app.
// Why: The app owns login, settings, and pending Share Extension captures.

import Foundation
import SwiftUI

@main
struct KinicApp: App {
    @State private var model: AppModel

    init() {
#if DEBUG
        if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "ask-ai" {
            _model = State(initialValue: .preview())
        } else {
            _model = State(initialValue: .live())
        }
#else
        _model = State(initialValue: .live())
#endif
    }

    var body: some Scene {
        WindowGroup {
            rootView
        }
    }

    @ViewBuilder
    private var rootView: some View {
#if DEBUG
        if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "ask-ai" {
            AskAIScreenshotPreview()
                .tint(KinicDesign.hotPink)
                .preferredColorScheme(.light)
        } else {
            liveView
        }
#else
        liveView
#endif
    }

    private var liveView: some View {
        HomeView(model: model)
            .tint(KinicDesign.hotPink)
            .preferredColorScheme(model.isDarkAppearanceEnabled ? .dark : .light)
            .onOpenURL { url in
                model.handleOpenURL(url)
            }
    }
}
