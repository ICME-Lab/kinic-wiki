// Where: mobile/ios/KinicApp/Services/VoiceCaptureCoordinator.swift
// What: Main-actor state machine for dictation capture and draft preservation.
// Why: Permission, recording, review, and save states must remain mutually exclusive.

import AVFAudio
import Foundation
import Observation
import Speech

enum VoiceCapturePhase: Equatable, Sendable {
    case idle
    case requestingPermission
    case recording
    case reviewing
    case saving
    case failed
}

enum VoiceCaptureError: Error, LocalizedError, Equatable {
    case microphonePermissionDenied
    case speechPermissionDenied
    case onDeviceRecognitionUnavailable(String)
    case recordingInterrupted
    case emptyTranscript
    case storageUnavailable(String)
    case recordingUnavailable(String)
    case transcriptionFailed(String)

    var errorDescription: String? {
        switch self {
        case .microphonePermissionDenied:
            "Microphone access is required. Allow it in Settings and try again."
        case .speechPermissionDenied:
            "Speech Recognition access is required. Allow it in Settings and try again."
        case let .onDeviceRecognitionUnavailable(language):
            "On-device speech recognition is unavailable for \(language) on this device."
        case .recordingInterrupted:
            "Recording was interrupted by another audio session."
        case .emptyTranscript:
            "Speak before stopping the voice note."
        case let .storageUnavailable(message):
            "Voice draft storage is unavailable: \(message)"
        case let .recordingUnavailable(message):
            "Voice memo recording is unavailable: \(message)"
        case let .transcriptionFailed(message):
            "The audio was kept on this device, but transcription failed: \(message)"
        }
    }
}

@MainActor
protocol VoiceMemoEngineProtocol: AnyObject {
    func supportsOnDeviceRecognition(locale: Locale) -> Bool
    func startRecording(
        to url: URL,
        maximumDuration: TimeInterval,
        onFinished: @escaping @MainActor (URL) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws
    func stopRecording()
    func cancelRecording(deleteFile: Bool)
    func transcribe(
        url: URL,
        locale: Locale,
        onTranscript: @escaping @MainActor (String) -> Void,
        onCompletion: @escaping @MainActor (Result<String, Error>) -> Void
    )
}

@MainActor
protocol VoiceDictationEngineProtocol: AnyObject {
    func requestPermissions() async -> VoiceCapturePermissionResult
    func supportsOnDeviceRecognition(locale: Locale) -> Bool
    func start(
        locale: Locale,
        onTranscript: @escaping @MainActor (String, Bool) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws
    func stop()
    func cancel()
}

struct VoiceCapturePermissionResult: Equatable, Sendable {
    let microphoneGranted: Bool
    let speechGranted: Bool
}

@MainActor
@Observable
final class VoiceCaptureCoordinator {
    private let store: VoiceCaptureStore
    private let engine: VoiceDictationEngineProtocol
    private let voiceMemoEngine: VoiceMemoEngineProtocol
    private let now: () -> Date
    private var timerTask: Task<Void, Never>?
    private var startedAt: Date?
    private var didStart = false
    private var activeMode: VoiceCaptureMode?

    private(set) var phase: VoiceCapturePhase = .idle
    private(set) var draft: VoiceCaptureDraft?
    private(set) var elapsedSeconds: Int = 0
    private(set) var errorMessage: String?
    private(set) var isTranscribing = false

    init(
        store: VoiceCaptureStore,
        engine: VoiceDictationEngineProtocol = VoiceDictationEngine(),
        voiceMemoEngine: VoiceMemoEngineProtocol = VoiceMemoEngine(),
        now: @escaping () -> Date = Date.init
    ) {
        self.store = store
        self.engine = engine
        self.voiceMemoEngine = voiceMemoEngine
        self.now = now
    }

    func start(
        mode: VoiceCaptureMode,
        language: WikiOutputLanguage,
        scope: VoiceCaptureAccountScope,
        databaseId: String?
    ) async {
        guard !didStart, phase == .idle || phase == .failed else { return }
        didStart = true
        activeMode = mode
        phase = .requestingPermission
        errorMessage = nil
        let permission = await engine.requestPermissions()
        guard permission.microphoneGranted else {
            fail(VoiceCaptureError.microphonePermissionDenied)
            return
        }
        guard permission.speechGranted else {
            fail(VoiceCaptureError.speechPermissionDenied)
            return
        }

        let locale = Locale(identifier: language.rawValue)
        let supportsOnDevice = mode == .dictation
            ? engine.supportsOnDeviceRecognition(locale: locale)
            : voiceMemoEngine.supportsOnDeviceRecognition(locale: locale)
        guard supportsOnDevice else {
            fail(VoiceCaptureError.onDeviceRecognitionUnavailable(language.displayName))
            return
        }

        let capturedAt = now()
        let id = UUID()
        draft = VoiceCaptureDraft(
            id: id,
            mode: mode,
            scope: scope,
            capturedAt: capturedAt,
            title: VoiceCaptureDocument.defaultTitle(capturedAt: capturedAt),
            transcript: "",
            language: language,
            durationMilliseconds: 0,
            databaseId: databaseId,
            audioFilename: nil,
            kinicPath: nil
        )
        startedAt = capturedAt
        elapsedSeconds = 0

        do {
            switch mode {
            case .dictation:
                try engine.start(
                    locale: locale,
                    onTranscript: { [weak self] transcript, isFinal in
                        self?.receiveTranscript(transcript, isFinal: isFinal)
                    },
                    onFailure: { [weak self] error in
                        self?.stopAfterFailure(error)
                    }
                )
            case .voiceMemo:
                let audioURL = try store.makeAudioURL(id: id, scope: scope)
                try voiceMemoEngine.startRecording(
                    to: audioURL,
                    maximumDuration: mode.maximumDuration,
                    onFinished: { [weak self] url in
                        self?.finishVoiceMemoRecording(audioURL: url)
                    },
                    onFailure: { [weak self] error in
                        self?.finishVoiceMemoRecording(error: error)
                    }
                )
                draft?.audioFilename = audioURL.lastPathComponent
                if let draft { try store.save(draft) }
            }
            phase = .recording
            scheduleTimer(maximumDuration: mode.maximumDuration)
        } catch {
            fail(error)
        }
    }

    func stop() {
        guard phase == .recording else { return }
        timerTask?.cancel()
        timerTask = nil
        updateDuration()
        if activeMode == .voiceMemo {
            voiceMemoEngine.stopRecording()
            return
        }
        engine.stop()
        guard let draft,
              !draft.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            fail(VoiceCaptureError.emptyTranscript)
            return
        }
        do {
            try store.save(draft)
            phase = .reviewing
        } catch {
            fail(VoiceCaptureError.storageUnavailable(error.localizedDescription))
        }
    }

    func preserveForDismissal() {
        if phase == .recording {
            timerTask?.cancel()
            timerTask = nil
            updateDuration()
            if activeMode == .voiceMemo {
                voiceMemoEngine.stopRecording()
                if let draft { try? store.save(draft) }
                return
            }
            engine.stop()
        }
        guard let draft,
              !draft.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return
        }
        do {
            try store.save(draft)
            phase = .reviewing
        } catch {
            errorMessage = VoiceCaptureError.storageUnavailable(error.localizedDescription).localizedDescription
            phase = .failed
        }
    }

    func updateReview(title: String, transcript: String, databaseId: String?) {
        guard var draft else { return }
        draft.title = title
        draft.transcript = transcript
        draft.databaseId = databaseId
        self.draft = draft
        try? store.save(draft)
    }

    func beginSaving() -> Bool {
        guard phase == .reviewing else { return false }
        phase = .saving
        errorMessage = nil
        return true
    }

    func finishSaving(savedPath: String) {
        guard var draft else { return }
        if draft.mode == .voiceMemo {
            draft.kinicPath = savedPath
            try? store.save(draft)
        } else {
            try? store.remove(draft)
        }
        self.draft = nil
        phase = .idle
        didStart = false
        activeMode = nil
    }

    func savingFailed(_ error: Error) {
        phase = .reviewing
        errorMessage = error.localizedDescription
        if let draft {
            try? store.save(draft)
        }
    }

    func discard() {
        engine.cancel()
        voiceMemoEngine.cancelRecording(deleteFile: true)
        timerTask?.cancel()
        timerTask = nil
        if let draft {
            try? store.remove(draft)
        }
        draft = nil
        phase = .idle
        errorMessage = nil
        didStart = false
        activeMode = nil
    }

    private func receiveTranscript(_ transcript: String, isFinal: Bool) {
        guard phase == .recording, var draft else { return }
        draft.transcript = transcript
        updateDuration(&draft)
        self.draft = draft
        if isFinal || elapsedSeconds % 2 == 0 {
            try? store.save(draft)
        }
    }

    private func stopAfterFailure(_ error: Error) {
        guard phase == .recording else { return }
        timerTask?.cancel()
        timerTask = nil
        updateDuration()
        if let draft,
           !draft.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try? store.save(draft)
            phase = .reviewing
            errorMessage = "Recording stopped: \(error.localizedDescription)"
        } else {
            fail(error)
        }
    }

    private func finishVoiceMemoRecording(audioURL: URL) {
        guard activeMode == .voiceMemo, phase == .recording, var draft else { return }
        timerTask?.cancel()
        timerTask = nil
        updateDuration(&draft)
        draft.audioFilename = audioURL.lastPathComponent
        self.draft = draft
        try? store.save(draft)
        phase = .reviewing
        isTranscribing = true
        let locale = Locale(identifier: draft.language.rawValue)
        voiceMemoEngine.transcribe(
            url: audioURL,
            locale: locale,
            onTranscript: { [weak self] transcript in
                self?.receiveVoiceMemoTranscript(transcript)
            },
            onCompletion: { [weak self] result in
                self?.completeVoiceMemoTranscription(result)
            }
        )
    }

    private func finishVoiceMemoRecording(error: Error) {
        guard activeMode == .voiceMemo, var draft else { return }
        timerTask?.cancel()
        timerTask = nil
        updateDuration(&draft)
        self.draft = draft
        try? store.save(draft)
        phase = .reviewing
        isTranscribing = false
        errorMessage = VoiceCaptureError.recordingUnavailable(error.localizedDescription).localizedDescription
    }

    private func receiveVoiceMemoTranscript(_ transcript: String) {
        guard var draft else { return }
        draft.transcript = transcript
        self.draft = draft
        try? store.save(draft)
    }

    private func completeVoiceMemoTranscription(_ result: Result<String, Error>) {
        isTranscribing = false
        switch result {
        case let .success(transcript):
            receiveVoiceMemoTranscript(transcript)
            errorMessage = nil
        case let .failure(error):
            errorMessage = VoiceCaptureError.transcriptionFailed(error.localizedDescription).localizedDescription
            if let draft { try? store.save(draft) }
        }
    }

    private func scheduleTimer(maximumDuration: TimeInterval) {
        timerTask?.cancel()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self else { return }
                self.updateDuration()
                if TimeInterval(self.elapsedSeconds) >= maximumDuration {
                    self.stop()
                    return
                }
            }
        }
    }

    private func updateDuration() {
        guard var draft else { return }
        updateDuration(&draft)
        self.draft = draft
    }

    private func updateDuration(_ draft: inout VoiceCaptureDraft) {
        guard let startedAt else { return }
        let milliseconds = max(0, Int64(now().timeIntervalSince(startedAt) * 1_000))
        draft.durationMilliseconds = milliseconds
        elapsedSeconds = Int(milliseconds / 1_000)
    }

    private func fail(_ error: Error) {
        engine.cancel()
        voiceMemoEngine.cancelRecording(deleteFile: draft?.hasAudio != true)
        timerTask?.cancel()
        timerTask = nil
        phase = .failed
        errorMessage = error.localizedDescription
    }
}

@MainActor
final class VoiceDictationEngine: VoiceDictationEngineProtocol {
    private let audioEngine = AVAudioEngine()
    private let interruptionObserver: VoiceDictationInterruptionObserver
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var speechRecognizer: SFSpeechRecognizer?
    private var inputTapInstalled = false

    init(interruptionObserver: VoiceDictationInterruptionObserver = VoiceDictationInterruptionObserver()) {
        self.interruptionObserver = interruptionObserver
    }

    func requestPermissions() async -> VoiceCapturePermissionResult {
        async let microphone = requestMicrophonePermission()
        async let speech = requestSpeechPermission()
        return await VoiceCapturePermissionResult(
            microphoneGranted: microphone,
            speechGranted: speech
        )
    }

    func supportsOnDeviceRecognition(locale: Locale) -> Bool {
        SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true
    }

    func start(
        locale: Locale,
        onTranscript: @escaping @MainActor (String, Bool) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws {
        cancel()
        guard let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.supportsOnDeviceRecognition else {
            throw VoiceCaptureError.onDeviceRecognitionUnavailable(locale.identifier)
        }
        speechRecognizer = recognizer
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        recognitionRequest = request

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
        inputTapInstalled = true
        audioEngine.prepare()
        try audioEngine.start()
        recognitionTask = recognizer.recognitionTask(with: request) { result, error in
            if let result {
                let transcript = result.bestTranscription.formattedString
                Task { @MainActor in
                    onTranscript(transcript, result.isFinal)
                }
            }
            if let error {
                Task { @MainActor in
                    onFailure(error)
                }
            }
        }
        interruptionObserver.start { [weak self] in
            guard let self else { return }
            self.stop()
            onFailure(VoiceCaptureError.recordingInterrupted)
        }
    }

    func stop() {
        interruptionObserver.stop()
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        removeInputTapIfNeeded()
        recognitionRequest?.endAudio()
        deactivateAudioSession()
    }

    func cancel() {
        interruptionObserver.stop()
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        removeInputTapIfNeeded()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        speechRecognizer = nil
        deactivateAudioSession()
    }

    private func removeInputTapIfNeeded() {
        guard inputTapInstalled else { return }
        audioEngine.inputNode.removeTap(onBus: 0)
        inputTapInstalled = false
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func requestMicrophonePermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    private func requestSpeechPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }
}

@MainActor
final class VoiceDictationInterruptionObserver {
    private let notificationCenter: NotificationCenter
    private let observedObject: AnyObject?
    private var token: NSObjectProtocol?
    private var didNotify = false

    init(
        notificationCenter: NotificationCenter = .default,
        observedObject: AnyObject? = AVAudioSession.sharedInstance()
    ) {
        self.notificationCenter = notificationCenter
        self.observedObject = observedObject
    }

    func start(onInterruption: @escaping @MainActor () -> Void) {
        stop()
        didNotify = false
        token = notificationCenter.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: observedObject,
            queue: .main
        ) { [weak self] notification in
            let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            MainActor.assumeIsolated {
                guard let self,
                      !self.didNotify,
                      typeValue == AVAudioSession.InterruptionType.began.rawValue else { return }
                self.didNotify = true
                onInterruption()
            }
        }
    }

    func stop() {
        if let token {
            notificationCenter.removeObserver(token)
        }
        token = nil
    }
}
