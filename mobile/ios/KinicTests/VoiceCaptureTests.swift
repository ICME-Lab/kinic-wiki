// Where: mobile/ios/KinicTests/VoiceCaptureTests.swift
// What: Voice draft, Markdown, and capture state regression tests.
// Why: Audio must remain local while transcript drafts survive interrupted saves.

import AVFAudio
import Foundation
import Testing
@testable import Kinic

struct VoiceCaptureTests {
    @Test
    func documentUsesStablePathMarkdownAndMetadataWithoutAudio() throws {
        let draft = makeDraft(
            id: UUID(uuidString: "12345678-1234-4234-8234-123456789abc")!,
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            transcript: "Remember the release checklist.",
            durationMilliseconds: 65_000
        )

        let document = try VoiceCaptureDocument.make(
            from: draft,
            title: "Release note\n",
            transcript: draft.transcript
        )

        #expect(document.path.hasPrefix("/Knowledge/Inbox/Voice Notes/"))
        #expect(document.path.hasSuffix("-12345678.md"))
        #expect(document.content.contains("# Release note"))
        #expect(document.content.contains("Duration: 01:05"))
        #expect(document.content.contains("Remember the release checklist."))
        #expect(!document.content.contains("base64"))

        let metadata = try #require(
            JSONSerialization.jsonObject(with: Data(document.metadataJson.utf8)) as? [String: Any]
        )
        #expect(metadata["kind"] as? String == "kinic.voice_note")
        #expect(metadata["version"] as? Int == 1)
        #expect(metadata["capture_mode"] as? String == "dictation")
        #expect(metadata["audio_retention"] as? String == "none")
        #expect(metadata["voice_note_id"] as? String == draft.id.uuidString.lowercased())
    }

    @Test
    func storeSeparatesGuestAndPrincipalDraftsAndDeletesOnlyRequestedScope() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let guest = makeDraft(scope: .guest, transcript: "guest")
        let principal = makeDraft(scope: .principal("aaaaa-aa"), transcript: "principal")
        try store.save(guest)
        try store.save(principal)

        #expect(store.load(scope: .guest).map(\.id) == [guest.id])
        #expect(store.load(scope: .principal("aaaaa-aa")).map(\.id) == [principal.id])

        try store.removeAll(scope: .principal("aaaaa-aa"))
        #expect(store.load(scope: .principal("aaaaa-aa")).isEmpty)
        #expect(store.load(scope: .guest).map(\.id) == [guest.id])
    }

    @Test
    func storeQuarantinesMalformedDrafts() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let draft = makeDraft(scope: .guest, transcript: "valid")
        try store.save(draft)
        let json = try #require(
            FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)?
                .compactMap { $0 as? URL }
                .first(where: { $0.pathExtension == "json" })
        )
        try Data("not-json".utf8).write(to: json, options: .atomic)

        #expect(store.load(scope: .guest).isEmpty)
        let quarantined = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }
            .filter { $0.path.contains("Corrupt") && $0.pathExtension == "json" } ?? []
        #expect(quarantined.count == 1)
    }

    @MainActor
    @Test
    func coordinatorPersistsPartialTranscriptAndIgnoresConcurrentStart() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let engine = VoiceDictationEngineFake()
        let clock = MutableClock(now: Date(timeIntervalSince1970: 1_700_000_000))
        let coordinator = VoiceCaptureCoordinator(store: store, engine: engine, now: { clock.now })

        await coordinator.start(
            mode: .dictation,
            language: .japanese,
            scope: .principal("aaaaa-aa"),
            databaseId: "db_1"
        )
        #expect(coordinator.phase == .recording)
        await coordinator.start(
            mode: .dictation,
            language: .japanese,
            scope: .principal("aaaaa-aa"),
            databaseId: "db_1"
        )
        #expect(coordinator.phase == .recording)
        #expect(engine.permissionRequestCount == 1)
        #expect(engine.cancelCount == 0)

        engine.emit("release checklist", isFinal: false)
        clock.now = clock.now.addingTimeInterval(12)
        coordinator.stop()

        #expect(coordinator.phase == .reviewing)
        let saved = try #require(store.load(scope: .principal("aaaaa-aa")).first)
        #expect(saved.transcript == "release checklist")
        #expect(saved.durationMilliseconds == 12_000)
        #expect(saved.audioFilename == nil)
    }

    @MainActor
    @Test
    func coordinatorPreservesPartialTranscriptAfterAudioInterruption() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let engine = VoiceDictationEngineFake()
        let coordinator = VoiceCaptureCoordinator(store: store, engine: engine)

        await coordinator.start(
            mode: .dictation,
            language: .japanese,
            scope: .guest,
            databaseId: "db_1"
        )
        engine.emit("interrupted note", isFinal: false)
        engine.emitFailure(VoiceCaptureError.recordingInterrupted)

        #expect(coordinator.phase == .reviewing)
        #expect(coordinator.errorMessage?.contains("Recording stopped") == true)
        #expect(store.load(scope: .guest).first?.transcript == "interrupted note")
    }

    @MainActor
    @Test
    func coordinatorDoesNotKeepEmptyDraftAfterAudioInterruption() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let engine = VoiceDictationEngineFake()
        let coordinator = VoiceCaptureCoordinator(store: store, engine: engine)

        await coordinator.start(
            mode: .dictation,
            language: .english,
            scope: .guest,
            databaseId: nil
        )
        engine.emitFailure(VoiceCaptureError.recordingInterrupted)

        #expect(coordinator.phase == .failed)
        #expect(store.load(scope: .guest).isEmpty)
    }

    @MainActor
    @Test
    func interruptionObserverNotifiesOnceAndStopsObserving() {
        let center = NotificationCenter()
        let source = NSObject()
        let observer = VoiceDictationInterruptionObserver(
            notificationCenter: center,
            observedObject: source
        )
        var interruptionCount = 0
        observer.start {
            interruptionCount += 1
        }

        postInterruption(center: center, source: source)
        postInterruption(center: center, source: source)
        #expect(interruptionCount == 1)

        observer.stop()
        postInterruption(center: center, source: source)
        #expect(interruptionCount == 1)
    }

    @MainActor
    @Test
    func coordinatorBlocksDeniedPermissionsAndUnsupportedOnDeviceLanguage() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)

        let deniedEngine = VoiceDictationEngineFake()
        deniedEngine.permission = VoiceCapturePermissionResult(microphoneGranted: false, speechGranted: true)
        let denied = VoiceCaptureCoordinator(store: store, engine: deniedEngine)
        await denied.start(mode: .dictation, language: .english, scope: .guest, databaseId: nil)
        #expect(denied.phase == .failed)
        #expect(denied.errorMessage == VoiceCaptureError.microphonePermissionDenied.localizedDescription)

        let unsupportedEngine = VoiceDictationEngineFake()
        unsupportedEngine.supportsOnDevice = false
        let unsupported = VoiceCaptureCoordinator(store: store, engine: unsupportedEngine)
        await unsupported.start(mode: .dictation, language: .english, scope: .guest, databaseId: nil)
        #expect(unsupported.phase == .failed)
        #expect(unsupported.errorMessage?.contains("On-device speech recognition is unavailable") == true)
        #expect(store.load(scope: .guest).isEmpty)
    }
}

@MainActor
private final class VoiceDictationEngineFake: VoiceDictationEngineProtocol {
    var permission = VoiceCapturePermissionResult(microphoneGranted: true, speechGranted: true)
    var supportsOnDevice = true
    private(set) var permissionRequestCount = 0
    private(set) var cancelCount = 0
    private var onTranscript: (@MainActor (String, Bool) -> Void)?
    private var onFailure: (@MainActor (Error) -> Void)?

    func requestPermissions() async -> VoiceCapturePermissionResult {
        permissionRequestCount += 1
        return permission
    }
    func supportsOnDeviceRecognition(locale: Locale) -> Bool { supportsOnDevice }

    func start(
        locale: Locale,
        onTranscript: @escaping @MainActor (String, Bool) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws {
        self.onTranscript = onTranscript
        self.onFailure = onFailure
    }

    func stop() {}
    func cancel() {
        cancelCount += 1
        onTranscript = nil
        onFailure = nil
    }

    func emit(_ transcript: String, isFinal: Bool) {
        onTranscript?(transcript, isFinal)
    }

    func emitFailure(_ error: Error) {
        onFailure?(error)
    }
}

@MainActor
private func postInterruption(center: NotificationCenter, source: NSObject) {
    center.post(
        name: AVAudioSession.interruptionNotification,
        object: source,
        userInfo: [AVAudioSessionInterruptionTypeKey: AVAudioSession.InterruptionType.began.rawValue]
    )
}

private final class MutableClock {
    var now: Date
    init(now: Date) { self.now = now }
}

private func makeDraft(
    id: UUID = UUID(),
    scope: VoiceCaptureAccountScope = .guest,
    capturedAt: Date = Date(timeIntervalSince1970: 1_700_000_000),
    transcript: String = "draft",
    durationMilliseconds: Int64 = 1_000
) -> VoiceCaptureDraft {
    VoiceCaptureDraft(
        id: id,
        mode: .dictation,
        scope: scope,
        capturedAt: capturedAt,
        title: "Voice note",
        transcript: transcript,
        language: .english,
        durationMilliseconds: durationMilliseconds,
        databaseId: "db_1",
        audioFilename: nil
    )
}

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory
        .appending(path: "kinic-voice-capture-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
}
