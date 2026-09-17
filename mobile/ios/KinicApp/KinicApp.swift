// Where: mobile/ios/KinicApp/KinicApp.swift
// What: SwiftUI entry point for the Kinic iOS app.
// Why: The app owns login, settings, and pending Share Extension captures.

import Foundation
import SwiftUI

@main
struct KinicApp: App {
    @State private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    init() {
#if DEBUG
        if ["ask-ai", "voice-preview", "voice-settings"].contains(ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] ?? "") {
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
        if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "voice-settings" {
            NavigationStack { VoiceSettingsView(appModel: model) }
                .environment(\.dynamicTypeSize, ProcessInfo.processInfo.environment["KINIC_LARGE_TEXT"] == "1" ? .accessibility3 : .large)
        } else if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "voice-preview" {
            VoicePreviewView(appModel: model, model: model.voicePreview)
                .task { model.voicePreview.loadScreenshotFixture() }
        } else if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "ask-ai" {
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
