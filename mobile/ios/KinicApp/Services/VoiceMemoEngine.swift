// Where: mobile/ios/KinicApp/Services/VoiceMemoEngine.swift
// What: Device-local AAC recording, interruption handling, playback, and on-device URL transcription.
// Why: Voice memo audio must remain useful locally without ever entering a Kinic payload.

import AVFAudio
import Foundation
import Observation
import Speech

@MainActor
final class VoiceMemoEngine: NSObject, VoiceMemoEngineProtocol, AVAudioRecorderDelegate {
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var onFinished: (@MainActor (URL) -> Void)?
    private var onFailure: (@MainActor (Error) -> Void)?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var notificationTokens: [NSObjectProtocol] = []
    private var wasRecordingBeforeInterruption = false
    private var didFinish = false
    private var lastRecordedDuration: TimeInterval = 0
    private var maximumDuration: TimeInterval = 0

    var recordedDuration: TimeInterval {
        recorder?.currentTime ?? lastRecordedDuration
    }

    func supportsOnDeviceRecognition(locale: Locale) -> Bool {
        SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true
    }

    func startRecording(
        to url: URL,
        maximumDuration: TimeInterval,
        onFinished: @escaping @MainActor (URL) -> Void,
        onFailure: @escaping @MainActor (Error) -> Void
    ) throws {
        cancelRecording(deleteFile: false)
        self.onFinished = onFinished
        self.onFailure = onFailure
        recordingURL = url
        didFinish = false
        lastRecordedDuration = 0
        self.maximumDuration = maximumDuration

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.allowBluetoothHFP, .defaultToSpeaker]
        )
        try session.setActive(true, options: .notifyOthersOnDeactivation)

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.prepareToRecord(), recorder.record(forDuration: maximumDuration) else {
            throw VoiceCaptureError.recordingUnavailable("The recorder could not start.")
        }
        self.recorder = recorder
        observeAudioSession()
    }

    func stopRecording() {
        captureRecordedDuration()
        recorder?.stop()
    }

    func cancelRecording(deleteFile: Bool) {
        recorder?.delegate = nil
        captureRecordedDuration()
        recorder?.stop()
        recognitionTask?.cancel()
        recognitionTask = nil
        removeAudioSessionObservers()
        if deleteFile, let recordingURL {
            try? FileManager.default.removeItem(at: recordingURL)
        }
        recorder = nil
        recordingURL = nil
        onFinished = nil
        onFailure = nil
        didFinish = false
        maximumDuration = 0
        if deleteFile {
            lastRecordedDuration = 0
        }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func transcribe(
        url: URL,
        locale: Locale,
        onTranscript: @escaping @MainActor (String) -> Void,
        onCompletion: @escaping @MainActor (Result<String, Error>) -> Void
    ) {
        recognitionTask?.cancel()
        guard let recognizer = SFSpeechRecognizer(locale: locale),
              recognizer.supportsOnDeviceRecognition else {
            onCompletion(.failure(VoiceCaptureError.onDeviceRecognitionUnavailable(locale.identifier)))
            return
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        request.taskHint = .dictation
        var completed = false
        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard !completed else { return }
                if let result {
                    let transcript = result.bestTranscription.formattedString
                    onTranscript(transcript)
                    if result.isFinal {
                        completed = true
                        self?.recognitionTask = nil
                        onCompletion(.success(transcript))
                        return
                    }
                }
                if let error {
                    completed = true
                    self?.recognitionTask = nil
                    onCompletion(.failure(error))
                }
            }
        }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            if flag {
                self.finishOnce()
            } else {
                self.failOnce(VoiceCaptureError.recordingUnavailable("Recording stopped before completion."))
            }
        }
    }

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor [weak self] in
            self?.failOnce(error ?? VoiceCaptureError.recordingUnavailable("The audio file could not be encoded."))
        }
    }

    private func finishOnce() {
        guard !didFinish, let recordingURL else { return }
        didFinish = true
        removeAudioSessionObservers()
        captureRecordedDuration()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onFinished?(recordingURL)
    }

    private func failOnce(_ error: Error) {
        guard !didFinish else { return }
        didFinish = true
        removeAudioSessionObservers()
        captureRecordedDuration()
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        onFailure?(error)
    }

    private func captureRecordedDuration() {
        lastRecordedDuration = max(lastRecordedDuration, recorder?.currentTime ?? 0)
    }

    private func observeAudioSession() {
        removeAudioSessionObservers()
        let center = NotificationCenter.default
        notificationTokens.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            MainActor.assumeIsolated {
                self?.handleInterruption(typeValue: typeValue, optionValue: optionValue)
            }
        })
        notificationTokens.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            let reasonValue = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            MainActor.assumeIsolated {
                self?.handleRouteChange(reasonValue: reasonValue)
            }
        })
    }

    private func removeAudioSessionObservers() {
        let center = NotificationCenter.default
        notificationTokens.forEach(center.removeObserver)
        notificationTokens.removeAll()
    }

    private func handleInterruption(typeValue: UInt?, optionValue: UInt) {
        guard let typeValue,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else { return }
        switch type {
        case .began:
            wasRecordingBeforeInterruption = recorder?.isRecording == true
            recorder?.pause()
        case .ended:
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionValue).contains(.shouldResume)
            let remainingDuration = max(0, maximumDuration - recordedDuration)
            if wasRecordingBeforeInterruption,
               shouldResume,
               remainingDuration > 0,
               recorder?.record(forDuration: remainingDuration) == true {
                wasRecordingBeforeInterruption = false
            } else {
                stopRecording()
            }
        @unknown default:
            stopRecording()
        }
    }

    private func handleRouteChange(reasonValue: UInt?) {
        guard let reasonValue,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else { return }
        if reason == .oldDeviceUnavailable, recorder?.isRecording == false {
            stopRecording()
        }
    }
}

@MainActor
@Observable
final class VoiceMemoPlayer: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var progressTask: Task<Void, Never>?
    private(set) var isPlaying = false
    private(set) var currentTime: TimeInterval = 0
    private(set) var duration: TimeInterval = 0

    func load(url: URL) throws {
        stop()
        player = try AVAudioPlayer(contentsOf: url)
        player?.delegate = self
        player?.prepareToPlay()
        duration = player?.duration ?? 0
    }

    func togglePlayback() {
        guard let player else { return }
        if player.isPlaying {
            player.pause()
            isPlaying = false
            progressTask?.cancel()
        } else if player.play() {
            isPlaying = true
            trackProgress()
        }
    }

    func seek(to time: TimeInterval) {
        player?.currentTime = min(max(0, time), duration)
        currentTime = player?.currentTime ?? 0
    }

    func stop() {
        progressTask?.cancel()
        progressTask = nil
        player?.stop()
        player = nil
        isPlaying = false
        currentTime = 0
        duration = 0
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in
            self?.isPlaying = false
            self?.currentTime = 0
            self?.progressTask?.cancel()
        }
    }

    private func trackProgress() {
        progressTask?.cancel()
        progressTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self else { return }
                self.currentTime = self.player?.currentTime ?? 0
                if self.player?.isPlaying != true {
                    self.isPlaying = false
                    return
                }
            }
        }
    }
}
