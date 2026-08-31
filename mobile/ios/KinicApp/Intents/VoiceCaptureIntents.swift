// Where: mobile/ios/KinicApp/Intents/VoiceCaptureIntents.swift
// What: Siri and Shortcuts entry point for foreground voice capture.
// Why: System surfaces should open the same universal-link flow as WidgetKit.

import AppIntents

struct StartVoiceNoteIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Voice Note"
    static let description = IntentDescription("Open KinicWiki and dictate an on-device voice note.")

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(VoiceCaptureLink.url(mode: .dictation)))
    }
}

struct StartVoiceMemoIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Voice Memo"
    static let description = IntentDescription("Open KinicWiki and record an audio memo kept on this device.")

    func perform() async throws -> some IntentResult & OpensIntent {
        .result(opensIntent: OpenURLIntent(VoiceCaptureLink.url(mode: .voiceMemo)))
    }
}

struct KinicVoiceAppShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartVoiceNoteIntent(),
            phrases: [
                "Start a voice note in \(.applicationName)",
                "Dictate a note in \(.applicationName)"
            ],
            shortTitle: "Voice Note",
            systemImageName: "mic.fill"
        )
        AppShortcut(
            intent: StartVoiceMemoIntent(),
            phrases: [
                "Start a voice memo in \(.applicationName)",
                "Record a memo in \(.applicationName)"
            ],
            shortTitle: "Voice Memo",
            systemImageName: "waveform"
        )
    }
}
