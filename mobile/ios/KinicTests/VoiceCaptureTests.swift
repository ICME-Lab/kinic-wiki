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

    @Test
    func completedDraftReviewDoesNotPersistAgainOnDisappear() {
        var completion = VoiceDraftReviewSaveCompletion()
        #expect(completion.shouldPersistOnDisappear)

        completion.markCompleted()

        #expect(!completion.shouldPersistOnDisappear)
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
        await waitForTranscription(memoEngine)

        #expect(coordinator.phase == .reviewing)
        #expect(coordinator.isTranscribing)
        #expect(!coordinator.beginSaving())
        memoEngine.emitTranscription("途中の文字起こし")
        #expect(!coordinator.beginSaving())
        memoEngine.completeTranscription("端末内のメモ")
        #expect(coordinator.beginSaving())
        try coordinator.finishSaving(savedPath: "/Knowledge/Inbox/Voice Notes/memo.md")
        let saved = try #require(store.load(scope: .guest).first)
        #expect(saved.transcript == "端末内のメモ")
        #expect(saved.hasAudio)
        #expect(saved.kinicPath == "/Knowledge/Inbox/Voice Notes/memo.md")
        #expect(store.audioURL(for: saved) != nil)
    }

    @MainActor
    @Test
    func coordinatorUsesRecordedAudioDurationInsteadOfWallClockTime() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let memoEngine = VoiceMemoEngineFake()
        let clock = MutableClock(now: Date(timeIntervalSince1970: 1_700_000_000))
        let coordinator = VoiceCaptureCoordinator(
            store: store,
            engine: VoiceDictationEngineFake(),
            voiceMemoEngine: memoEngine,
            now: { clock.now }
        )

        await coordinator.start(
            mode: .voiceMemo,
            language: .english,
            scope: .guest,
            databaseId: nil
        )
        clock.now = clock.now.addingTimeInterval(300)
        memoEngine.recordedDuration = 12.25
        coordinator.stop()
        memoEngine.finishRecording()
        await waitForTranscription(memoEngine)

        let saved = try #require(store.load(scope: .guest).first)
        #expect(saved.durationMilliseconds == 12_250)
        #expect(coordinator.elapsedSeconds == 12)
    }

    @MainActor
    @Test
    func coordinatorAllowsEditingAfterTranscriptionFailure() async throws {
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
            language: .english,
            scope: .guest,
            databaseId: "db_1"
        )
        coordinator.stop()
        memoEngine.finishRecording()
        await waitForTranscription(memoEngine)
        memoEngine.emitTranscription("usable partial transcript")
        memoEngine.failTranscription()

        #expect(!coordinator.isTranscribing)
        #expect(coordinator.beginSaving())
    }

    @MainActor
    @Test
    func coordinatorRetainsVoiceMemoWhenLocalSaveFinalizationFails() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let baseStore = try VoiceCaptureStore(rootDirectory: directory)
        let store = VoiceCaptureStoreFake(base: baseStore)
        let memoEngine = VoiceMemoEngineFake()
        let coordinator = VoiceCaptureCoordinator(
            store: store,
            engine: VoiceDictationEngineFake(),
            voiceMemoEngine: memoEngine
        )

        await coordinator.start(mode: .voiceMemo, language: .english, scope: .guest, databaseId: "db_1")
        coordinator.stop()
        memoEngine.finishRecording()
        await waitForTranscription(memoEngine)
        memoEngine.completeTranscription("locally retained memo")
        #expect(coordinator.beginSaving())
        store.failSaves = true

        do {
            try coordinator.finishSaving(savedPath: "/Knowledge/Inbox/Voice Notes/saved.md")
            Issue.record("Expected local finalization to fail")
        } catch {
            coordinator.savingFailed(error)
        }

        let retained = try #require(coordinator.draft)
        #expect(coordinator.phase == .reviewing)
        #expect(retained.hasAudio)
        #expect(retained.kinicPath == "/Knowledge/Inbox/Voice Notes/saved.md")
        #expect(baseStore.audioURL(for: retained) != nil)
    }

    @MainActor
    @Test
    func coordinatorIndexesPartialAACBeforeRecordingFailure() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let memoEngine = VoiceMemoEngineFake()
        let coordinator = VoiceCaptureCoordinator(
            store: store,
            engine: VoiceDictationEngineFake(),
            voiceMemoEngine: memoEngine
        )

        await coordinator.start(mode: .voiceMemo, language: .english, scope: .guest, databaseId: nil)
        let indexedBeforeFailure = try #require(store.load(scope: .guest).first)
        #expect(indexedBeforeFailure.hasAudio)
        #expect(store.audioURL(for: indexedBeforeFailure) != nil)

        memoEngine.recordedDuration = 4.5
        memoEngine.failRecording()

        let retained = try #require(store.load(scope: .guest).first)
        #expect(coordinator.phase == .reviewing)
        #expect(retained.audioFilename == indexedBeforeFailure.audioFilename)
        #expect(retained.durationMilliseconds == 4_500)
        #expect(store.audioURL(for: retained) != nil)
    }

    @MainActor
    @Test
    func voiceMemoResumeReactivatesAudioSessionBeforeRecording() throws {
        var events: [String] = []

        try VoiceMemoEngine.resumeAfterInterruption(
            activateAudioSession: { events.append("activate") },
            resumeRecording: {
                events.append("record")
                return true
            }
        )

        #expect(events == ["activate", "record"])

        events = []
        do {
            try VoiceMemoEngine.resumeAfterInterruption(
                activateAudioSession: {
                    events.append("activate")
                    throw VoiceCaptureError.recordingUnavailable("activation failed")
                },
                resumeRecording: {
                    events.append("record")
                    return true
                }
            )
            Issue.record("Expected audio session activation to fail")
        } catch {}
        #expect(events == ["activate"])
    }

    @MainActor
    @Test
    func coordinatorRecordsVoiceMemoWithoutSpeechPermissionOrRecognitionSupport() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let dictationEngine = VoiceDictationEngineFake()
        dictationEngine.permission = VoiceCapturePermissionResult(
            microphoneGranted: true,
            speechGranted: false
        )
        let memoEngine = VoiceMemoEngineFake()
        memoEngine.supportsOnDevice = false
        let coordinator = VoiceCaptureCoordinator(
            store: store,
            engine: dictationEngine,
            voiceMemoEngine: memoEngine
        )

        await coordinator.start(mode: .voiceMemo, language: .english, scope: .guest, databaseId: nil)

        #expect(coordinator.phase == .recording)
        #expect(dictationEngine.microphonePermissionRequestCount == 1)
        #expect(dictationEngine.speechPermissionRequestCount == 0)
        let recorded = try #require(store.load(scope: .guest).first)
        #expect(recorded.hasAudio)

        coordinator.stop()
        memoEngine.finishRecording()
        while dictationEngine.speechPermissionRequestCount == 0 {
            await Task.yield()
        }
        while coordinator.isTranscribing {
            await Task.yield()
        }

        #expect(coordinator.phase == .reviewing)
        #expect(coordinator.draft?.hasAudio == true)
        #expect(coordinator.errorMessage?.contains("Speech Recognition access is required") == true)
        #expect(memoEngine.transcribeCount == 0)
    }

    @MainActor
    @Test
    func coordinatorCancelsPermissionStartupWhenDismissed() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let engine = VoiceDictationEngineFake()
        engine.holdPermissions = true
        let coordinator = VoiceCaptureCoordinator(store: store, engine: engine)

        let startTask = Task {
            await coordinator.start(
                mode: .dictation,
                language: .japanese,
                scope: .guest,
                databaseId: nil
            )
        }
        await waitForPermissionRequest(engine)
        #expect(coordinator.phase == .requestingPermission)

        coordinator.preserveForDismissal()
        coordinator.preserveForDismissal()
        engine.resolvePermissions()
        await startTask.value

        #expect(coordinator.phase == .idle)
        #expect(coordinator.draft == nil)
        #expect(coordinator.elapsedSeconds == 0)
        #expect(engine.startCount == 0)
        #expect(store.load(scope: .guest).isEmpty)
    }

    @MainActor
    @Test
    func coordinatorCanRetryAfterPermissionStartupCancellation() async throws {
        let directory = temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try VoiceCaptureStore(rootDirectory: directory)
        let engine = VoiceDictationEngineFake()
        engine.holdPermissions = true
        let coordinator = VoiceCaptureCoordinator(store: store, engine: engine)

        let cancelledStart = Task {
            await coordinator.start(mode: .dictation, language: .english, scope: .guest, databaseId: nil)
        }
        await waitForPermissionRequest(engine)
        coordinator.discard()
        engine.resolvePermissions()
        await cancelledStart.value

        engine.holdPermissions = false
        await coordinator.start(mode: .dictation, language: .english, scope: .guest, databaseId: nil)

        #expect(coordinator.phase == .recording)
        #expect(engine.permissionRequestCount == 2)
        #expect(engine.startCount == 1)
    }
}

@MainActor
private final class VoiceDictationEngineFake: VoiceDictationEngineProtocol {
    var permission = VoiceCapturePermissionResult(microphoneGranted: true, speechGranted: true)
    var supportsOnDevice = true
    var holdPermissions = false
    private(set) var permissionRequestCount = 0
    private(set) var microphonePermissionRequestCount = 0
    private(set) var speechPermissionRequestCount = 0
    private(set) var cancelCount = 0
    private(set) var startCount = 0
    private var permissionContinuation: CheckedContinuation<VoiceCapturePermissionResult, Never>?
    private var onTranscript: (@MainActor (String, Bool) -> Void)?
    private var onFailure: (@MainActor (Error) -> Void)?

    func requestPermissions() async -> VoiceCapturePermissionResult {
        permissionRequestCount += 1
        if holdPermissions {
            return await withCheckedContinuation { continuation in
                permissionContinuation = continuation
            }
        }
        return permission
    }
    func requestMicrophonePermission() async -> Bool {
        microphonePermissionRequestCount += 1
        return permission.microphoneGranted
    }
    func requestSpeechPermission() async -> Bool {
        speechPermissionRequestCount += 1
        return permission.speechGranted
    }
    func supportsOnDeviceRecognition(locale: Locale) -> Bool { supportsOnDevice }

    func start(
        locale: Locale,
        onTranscript: @escaping @MainActor (String, Bool) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws {
        startCount += 1
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

    func resolvePermissions() {
        holdPermissions = false
        permissionContinuation?.resume(returning: permission)
        permissionContinuation = nil
    }
}

@MainActor
private func waitForPermissionRequest(_ engine: VoiceDictationEngineFake) async {
    while engine.permissionRequestCount == 0 {
        await Task.yield()
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

@MainActor
private final class VoiceMemoEngineFake: VoiceMemoEngineProtocol {
    var maximumDuration: TimeInterval?
    var recordedDuration: TimeInterval = 0
    var supportsOnDevice = true
    private(set) var transcribeCount = 0
    private var url: URL?
    private var onFinished: (@MainActor (URL) -> Void)?
    private var onFailure: (@MainActor (Error) -> Void)?
    private var onTranscript: (@MainActor (String) -> Void)?
    private var onCompletion: (@MainActor (Result<String, Error>) -> Void)?

    func supportsOnDeviceRecognition(locale: Locale) -> Bool { supportsOnDevice }

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
        self.onFailure = onFailure
    }

    func stopRecording() {}
    func cancelRecording(deleteFile: Bool) {}

    func transcribe(
        url: URL,
        locale: Locale,
        onTranscript: @escaping @MainActor (String) -> Void,
        onCompletion: @escaping @MainActor (Result<String, Error>) -> Void
    ) {
        transcribeCount += 1
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

    func emitTranscription(_ value: String) {
        onTranscript?(value)
    }

    func failTranscription() {
        onCompletion?(.failure(VoiceCaptureError.transcriptionFailed("test failure")))
    }

    func failRecording() {
        onFailure?(VoiceCaptureError.recordingUnavailable("test recording failure"))
    }
}

@MainActor
private func waitForTranscription(_ engine: VoiceMemoEngineFake) async {
    while engine.transcribeCount == 0 {
        await Task.yield()
    }
}

private final class VoiceCaptureStoreFake: VoiceCaptureStoring {
    let base: VoiceCaptureStore
    var failSaves = false

    init(base: VoiceCaptureStore) {
        self.base = base
    }

    func save(_ draft: VoiceCaptureDraft) throws {
        if failSaves {
            throw VoiceCaptureError.storageUnavailable("test save failure")
        }
        try base.save(draft)
    }

    func remove(_ draft: VoiceCaptureDraft, includingAudio: Bool) throws {
        try base.remove(draft, includingAudio: includingAudio)
    }

    func makeAudioURL(id: UUID, scope: VoiceCaptureAccountScope) throws -> URL {
        try base.makeAudioURL(id: id, scope: scope)
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
