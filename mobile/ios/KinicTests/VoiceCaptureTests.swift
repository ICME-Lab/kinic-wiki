// Where: mobile/ios/KinicTests/VoiceCaptureTests.swift
// What: Voice draft, Markdown, and capture state regression tests.
// Why: Audio must remain local while transcript drafts survive interrupted saves.

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

    @Test
    func voiceMemoMetadataReferencesOnlyTheDeviceLocalIdentity() throws {
        let draft = makeDraft(mode: .voiceMemo, transcript: "Local recording transcript")
        let document = try VoiceCaptureDocument.make(
            from: draft,
            title: draft.title,
            transcript: draft.transcript
        )
        let metadata = try #require(
            JSONSerialization.jsonObject(with: Data(document.metadataJson.utf8)) as? [String: Any]
        )

        #expect(metadata["capture_mode"] as? String == "voice_memo")
        #expect(metadata["audio_retention"] as? String == "device_local")
        #expect(!document.content.contains(".m4a"))
        #expect(!document.metadataJson.contains(".m4a"))
        #expect(VoiceCaptureMode.voiceMemo.maximumDuration == 30 * 60)
    }

    @Test
    func storeCanDeleteVoiceMemoAudioWithoutDeletingTranscript() throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        var draft = makeDraft(mode: .voiceMemo, transcript: "Keep this")
        let audioURL = try store.makeAudioURL(id: draft.id, scope: draft.scope)
        try Data([0, 1, 2]).write(to: audioURL, options: .atomic)
        draft.audioFilename = audioURL.lastPathComponent
        try store.save(draft)

        let updated = try store.removeAudio(from: draft)

        #expect(updated.audioFilename == nil)
        #expect(!FileManager.default.fileExists(atPath: audioURL.path))
        #expect(store.load(scope: draft.scope).first?.transcript == "Keep this")
    }

    @MainActor
    @Test
    func coordinatorPersistsPartialTranscriptAndRejectsConcurrentStart() async throws {
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
        #expect(coordinator.phase == .failed)

        coordinator.discard()
        await coordinator.start(
            mode: .dictation,
            language: .japanese,
            scope: .principal("aaaaa-aa"),
            databaseId: "db_1"
        )
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

    @MainActor
    @Test
    func coordinatorKeepsAACAndTranscribesAfterVoiceMemoStops() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let memoEngine = VoiceMemoEngineFake()
        let coordinator = VoiceCaptureCoordinator(
            store: store,
            engine: VoiceDictationEngineFake(),
            voiceMemoEngine: memoEngine
        )

        await coordinator.start(
            mode: .voiceMemo,
            language: .japanese,
            scope: .guest,
            databaseId: nil
        )
        #expect(coordinator.phase == .recording)
        let maximumDuration = try #require(memoEngine.maximumDuration)
        #expect(maximumDuration == VoiceCaptureMode.voiceMemo.maximumDuration)
        coordinator.stop()
        memoEngine.finishRecording()

        #expect(coordinator.phase == .reviewing)
        #expect(coordinator.isTranscribing)
        memoEngine.completeTranscription("端末内のメモ")
        let saved = try #require(store.load(scope: .guest).first)
        #expect(saved.transcript == "端末内のメモ")
        #expect(saved.hasAudio)
        #expect(store.audioURL(for: saved) != nil)
    }
}

@MainActor
private final class VoiceDictationEngineFake: VoiceDictationEngineProtocol {
    var permission = VoiceCapturePermissionResult(microphoneGranted: true, speechGranted: true)
    var supportsOnDevice = true
    private var onTranscript: (@MainActor (String, Bool) -> Void)?

    func requestPermissions() async -> VoiceCapturePermissionResult { permission }
    func supportsOnDeviceRecognition(locale: Locale) -> Bool { supportsOnDevice }

    func start(
        locale: Locale,
        onTranscript: @escaping @MainActor (String, Bool) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws {
        self.onTranscript = onTranscript
    }

    func stop() {}
    func cancel() { onTranscript = nil }

    func emit(_ transcript: String, isFinal: Bool) {
        onTranscript?(transcript, isFinal)
    }
}

@MainActor
private final class VoiceMemoEngineFake: VoiceMemoEngineProtocol {
    var maximumDuration: TimeInterval?
    private var url: URL?
    private var onFinished: (@MainActor (URL) -> Void)?
    private var onTranscript: (@MainActor (String) -> Void)?
    private var onCompletion: (@MainActor (Result<String, Error>) -> Void)?

    func supportsOnDeviceRecognition(locale: Locale) -> Bool { true }

    func startRecording(
        to url: URL,
        maximumDuration: TimeInterval,
        onFinished: @escaping @MainActor (URL) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws {
        try Data([0, 1, 2]).write(to: url, options: .atomic)
        self.url = url
        self.maximumDuration = maximumDuration
        self.onFinished = onFinished
    }

    func stopRecording() {}
    func cancelRecording(deleteFile: Bool) {}

    func transcribe(
        url: URL,
        locale: Locale,
        onTranscript: @escaping @MainActor (String) -> Void,
        onCompletion: @escaping @MainActor (Result<String, Error>) -> Void
    ) {
        self.onTranscript = onTranscript
        self.onCompletion = onCompletion
    }

    func finishRecording() {
        if let url { onFinished?(url) }
    }

    func completeTranscription(_ value: String) {
        onTranscript?(value)
        onCompletion?(.success(value))
    }
}

private final class MutableClock {
    var now: Date
    init(now: Date) { self.now = now }
}

private func makeDraft(
    id: UUID = UUID(),
    mode: VoiceCaptureMode = .dictation,
    scope: VoiceCaptureAccountScope = .guest,
    capturedAt: Date = Date(timeIntervalSince1970: 1_700_000_000),
    transcript: String = "draft",
    durationMilliseconds: Int64 = 1_000
) -> VoiceCaptureDraft {
    VoiceCaptureDraft(
        id: id,
        mode: mode,
        scope: scope,
        capturedAt: capturedAt,
        title: "Voice note",
        transcript: transcript,
        language: .english,
        durationMilliseconds: durationMilliseconds,
        databaseId: "db_1",
        audioFilename: nil,
        kinicPath: nil
    )
}

private func temporaryDirectory() -> URL {
    FileManager.default.temporaryDirectory
        .appending(path: "kinic-voice-capture-tests-\(UUID().uuidString)", directoryHint: .isDirectory)
}
