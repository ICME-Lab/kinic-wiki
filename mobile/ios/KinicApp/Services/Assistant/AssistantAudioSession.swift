import AVFAudio
import Foundation
@preconcurrency import WebRTC

@MainActor
final class AssistantAudioSession: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    static let eventChannelLabel = "oai-events"

    private static let sharedFactory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()
    private lazy var factory = AssistantAudioSession.sharedFactory
    private var generation = 0
    private var peer: RTCPeerConnection?
    private var track: RTCAudioTrack?
    private var channel: RTCDataChannel?
    private var sessionStarted = false
    private var observers: [NSObjectProtocol] = []
    var onFailure: (() -> Void)?
    private(set) var running = false
    private(set) var muted = false

    func offer() async throws -> String {
        stop()
        let attempt = generation
        guard await AVAudioApplication.requestRecordPermission() else {
            throw AssistantHTTPError(status: 400, code: "microphone_denied")
        }
        guard generation == attempt else { throw CancellationError() }
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audio.setActive(true)
        let rtcAudio = RTCAudioSession.sharedInstance()
        rtcAudio.useManualAudio = true
        rtcAudio.isAudioEnabled = true
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let connection = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw URLError(.cannotConnectToHost)
        }
        peer = connection
        let source = factory.audioSource(with: constraints)
        let local = factory.audioTrack(with: source, trackId: "microphone")
        track = local
        local.isEnabled = false
        connection.add(local, streamIds: ["voice-preview"])
        channel = connection.dataChannel(
            forLabel: Self.eventChannelLabel,
            configuration: RTCDataChannelConfiguration()
        )
        channel?.delegate = self
        running = true
        observeInterruptions()
        let sdp: String = try await withCheckedThrowingContinuation { continuation in
            connection.offer(for: RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)) { description, error in
                if let description { continuation.resume(returning: description.sdp) }
                else { continuation.resume(throwing: error ?? URLError(.cannotConnectToHost)) }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.setLocalDescription(RTCSessionDescription(type: .offer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        for _ in 0..<100 {
            guard peer === connection else { throw CancellationError() }
            if connection.iceGatheringState == .complete { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard peer === connection else { throw CancellationError() }
        guard connection.iceGatheringState == .complete else { throw URLError(.timedOut) }
        guard let result = connection.localDescription?.sdp else { throw CancellationError() }
        return result
    }
    func answer(_ sdp: String) async throws {
        guard let peer else { throw CancellationError() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
    func waitUntilConnected() async throws {
        guard let peer else { throw CancellationError() }
        for _ in 0..<100 {
            guard self.peer === peer else { throw CancellationError() }
            if sessionStarted && (peer.iceConnectionState == .connected || peer.iceConnectionState == .completed) { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw URLError(.timedOut)
    }
    func activateMicrophone() { track?.isEnabled = !muted }
    func toggleMute() { muted.toggle(); track?.isEnabled = !muted }
    func stop() {
        generation += 1
        track?.isEnabled = false
        peer?.close()
        peer = nil
        track = nil
        channel?.close(); channel = nil; sessionStarted = false
        running = false
        muted = false
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func observeInterruptions() {
        observers = [NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            if type == AVAudioSession.InterruptionType.began.rawValue {
                Task { @MainActor in self?.onFailure?() }
            }
        }, NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                Task { @MainActor in self?.onFailure?() }
            }
        }]
    }
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}
    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard buffer.data.count <= 65536,
              let event = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any],
              event["type"] as? String == "session.started" else { return }
        Task { @MainActor [weak self] in
            guard self?.channel === dataChannel else { return }
            self?.sessionStarted = true
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        if newState == .failed || newState == .disconnected {
            Task { @MainActor [weak self] in
                guard self?.peer === peerConnection else { return }
                self?.onFailure?()
            }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
