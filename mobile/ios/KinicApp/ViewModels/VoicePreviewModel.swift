import Foundation
import CryptoKit
import Observation

/// A peer that stops sending is indistinguishable from a dead one unless the
/// client asks for a reply, so the control channel echoes every heartbeat.
enum AssistantLiveness {
    static let heartbeatSeconds = 10
    static let timeoutSeconds = 30

    static func shouldReconnect(lastReceivedAt: Date?, now: Date) -> Bool {
        guard let lastReceivedAt else { return false }
        return now.timeIntervalSince(lastReceivedAt) >= Double(timeoutSeconds)
    }

    /// Recognised explicitly so a heartbeat reply is never decoded as a
    /// conversation snapshot.
    static func isHeartbeatReply(_ value: [String: Any]) -> Bool {
        value["type"] as? String == "heartbeat"
    }

    static func heartbeatRequest(id: String) -> String {
        let data = try? JSONSerialization.data(withJSONObject: ["type": "heartbeat", "requestId": id])
        return data.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}

@MainActor @Observable
final class VoicePreviewModel {
    private(set) var snapshot: AssistantSnapshot?
    private(set) var error: String?
    private(set) var failureCode: String?
    private(set) var busy = false
    private(set) var voiceActive = false
    private(set) var muted = false
    private(set) var reconnecting = false
    var historyConversationID = UUID()
    var historyDatabaseTitle = ""
    @ObservationIgnored var saveHistory: ((AssistantSnapshot, UUID, String) async throws -> Void)?
    @ObservationIgnored private var historyTask: Task<Void, Never>?
    @ObservationIgnored private var pendingHistory: (snapshot: AssistantSnapshot, id: UUID, title: String, epoch: Int, save: (AssistantSnapshot, UUID, String) async throws -> Void)?
    private(set) var historyError = false
    private(set) var finishing = false
    private(set) var endingRequested = false
    private(set) var finalizationWarning: String?
    private(set) var controlReady = false
    var quote: AssistantQuote?
    var scope = "/Knowledge"
    var draft = ""
    let configuration: AppConfiguration
    @ObservationIgnored private let http: AssistantHTTPClient
    @ObservationIgnored private let authorization = AssistantNativeAuthorization()
    @ObservationIgnored private let audio = AssistantAudioSession()
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var heartbeat: Task<Void, Never>?
    @ObservationIgnored private var liveness: Task<Void, Never>?
    @ObservationIgnored private var lastReceivedAt: Date?
    @ObservationIgnored private var voiceDeadlineTask: Task<Void, Never>?
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var voiceEpoch = 0
    @ObservationIgnored private var activeVoiceId: String?
    @ObservationIgnored private var disconnectedAt: Date?
    @ObservationIgnored private var pendingQuestion: (id: String, text: String)?
    @ObservationIgnored private var background = false
    private func cache(for principal: String) -> AssistantConversationCache {
        let namespace = SHA256.hash(data: Data((configuration.canisterId + ":" + principal).utf8)).map { String(format: "%02x", $0) }.joined()
        return AssistantConversationCache(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appending(path: "VoiceHistoryRecovery/" + namespace, directoryHint: .isDirectory))
    }
    @ObservationIgnored private var boundPrincipal: String?
    @ObservationIgnored private var boundDatabaseId: String?
    @ObservationIgnored private var commands: [String: (attempt: UUID, continuation: CheckedContinuation<Data, Error>)] = [:]
    @ObservationIgnored private var retryingQuestion = false
    init(configuration: AppConfiguration) {
        self.configuration = configuration
        http = AssistantHTTPClient(configuration: configuration)
        audio.onFailure = { [weak self] in
            self?.stopVoice()
            self?.error = "Voice stopped after an audio interruption. Retry to resume."
        }
    }
#if DEBUG
    func loadScreenshotFixture() {
        let text = """
        {"revision":1,"id":"preview","databaseId":"demo","scope":"/Knowledge","status":"ready","error":null,"generation":1,"reconnectGraceMs":120000,"voice":"off","progress":null,"utterances":[],"messages":[{"voice":false,"requestId":"example","question":"What does this Wiki say?","error":null,"answer":{"answer":"This answer is grounded in the selected Wiki.","citations":[{"id":"source","databaseId":"demo","path":"/Knowledge/Overview","excerpt":"A short verified source excerpt.","etag":"v1"}],"insufficient":false,"contradictions":[],"unverified":[]}}]}
        """
        let state = ProcessInfo.processInfo.environment["KINIC_VOICE_STATE"] ?? "ready"
        var fixture = text
        if state == "responding" { fixture = fixture.replacingOccurrences(of: "\"status\":\"ready\"", with: "\"status\":\"working\"") }
        if state == "caveats" {
            fixture = fixture.replacingOccurrences(of: "\"insufficient\":false", with: "\"insufficient\":true")
                .replacingOccurrences(of: "\"contradictions\":[]", with: "\"contradictions\":[\"The dates differ between sources.\"]")
                .replacingOccurrences(of: "\"unverified\":[]", with: "\"unverified\":[\"The latest information could not be verified.\"]")
        }
        snapshot = try? JSONDecoder().decode(AssistantSnapshot.self, from: Data(fixture.utf8))
        busy = state == "connecting"
        voiceActive = state == "listening" || state == "responding"
        if state == "error" { error = AssistantHTTPError(status: 403, code: "voice_permission_required").localizedDescription }
        boundPrincipal = "owner"
        boundDatabaseId = "demo"
    }
#endif
    func forgetRecovery(conversationID: UUID?, principal: String) throws {
        let storage = cache(for: principal)
        if conversationID == nil { try storage.clear(); return }
        guard let saved = try storage.load(), saved.conversationID == conversationID else { return }
        try storage.clear()
    }
    func deleteAccountRecovery(principal: String) async throws {
        end()
        pendingHistory = nil
        await historyTask?.value
        saveHistory = nil
        try cache(for: principal).clear()
        for key in UserDefaults.standard.dictionaryRepresentation().keys
            where key.hasPrefix("voice.consent.\(principal).") || key.hasPrefix("voice.rate.\(principal).") || key == "voice.scope.\(principal)" {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
    func contextChanged(databaseId: String, principal: String) {
        if let boundPrincipal, let boundDatabaseId {
            if boundPrincipal != principal || boundDatabaseId != databaseId { end() }
            return
        }
        if boundPrincipal != nil || boundDatabaseId != nil || snapshot != nil { end(); return }
        guard !principal.isEmpty, !databaseId.isEmpty else { return }
        do {
            if let saved = try cache(for: principal).load(), saved.principal != principal || saved.snapshot.databaseId != databaseId { end() }
        } catch { end() }
    }
    func restore(databaseId: String, principal: String) async {
        guard !busy, snapshot == nil, !principal.isEmpty else { return }
        do {
            guard let saved = try cache(for: principal).load() else { return }
            guard saved.principal == principal else { return }
            historyConversationID = saved.conversationID
            historyDatabaseTitle = saved.databaseTitle
            // Recover the local copy before any terminal server response clears it.
            guard let saveHistory else { throw URLError(.cannotWriteToFile) }
            do { try await saveHistory(saved.snapshot, saved.conversationID, saved.databaseTitle) }
            catch { historyError = true; self.error = "Some voice history could not be saved. Retry saving it."; return }
            try Task.checkCancellation()
            historyError = false
            if try cache(for: principal).isEnding(conversationID: saved.conversationID) {
                endingRequested = true
                boundPrincipal = principal
                boundDatabaseId = saved.snapshot.databaseId
                snapshot = saved.snapshot
                historyError = true
                self.error = "The previous conversation did not finish ending. Retry ending it."
                return
            }
            if saved.snapshot.databaseId != databaseId { try cache(for: principal).clear(); return }
            epoch += 1
            let generation = epoch
            busy = true
            defer { if epoch == generation { busy = false } }
            let auth = try await http.data("auth")
            guard epoch == generation else { return }
            guard (try JSONSerialization.jsonObject(with: auth) as? [String: Any])?["principal"] as? String == principal else {
                throw AssistantHTTPError(status: 403, code: "identity_changed")
            }
            let state = try await http.snapshot(conversation: saved.snapshot.id)
            guard epoch == generation else { return }
            boundPrincipal = principal
            boundDatabaseId = databaseId
            try apply(state, database: databaseId)
            if let voiceId = snapshot?.voiceId {
                _ = try await http.data("voice/stop", conversation: saved.snapshot.id, method: "POST", body: ["voiceId": voiceId])
                guard epoch == generation else { return }
            }
            // A previous microphone connection is never recreated on process launch.
            listen(generation: generation)
        } catch {
            if let failure = error as? AssistantHTTPError, failure.terminal { end() }
            self.report(error)
        }
    }
    private func rejectCommands() {
        let pending = commands.values
        commands.removeAll()
        for item in pending { item.continuation.resume(throwing: URLError(.networkConnectionLost)) }
    }
    private func command(_ action: String, body: [String: Any] = [:], requestId: String = UUID().uuidString.lowercased()) async throws -> Data {
        guard let socket, let snapshot else { throw URLError(.notConnectedToInternet) }
        let packet = try JSONSerialization.data(withJSONObject: ["type": "command", "action": action,
            "payload": body, "requestId": requestId, "generation": snapshot.generation])
        return try await withCheckedThrowingContinuation { continuation in
            let attempt = UUID()
            commands[requestId] = (attempt, continuation)
            Task { [weak self] in
                do { try await socket.send(.string(String(decoding: packet, as: UTF8.self))) }
                catch { if self?.commands[requestId]?.attempt == attempt { self?.commands.removeValue(forKey: requestId)?.continuation.resume(throwing: error) } }
            }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(95))
                if self?.commands[requestId]?.attempt == attempt { self?.commands.removeValue(forKey: requestId)?.continuation.resume(throwing: URLError(.timedOut)) }
            }
        }
    }
    private func receiveCommand(_ value: [String: Any]) throws -> Bool {
        guard value["type"] as? String == "command.result" else { return false }
        guard let id = value["requestId"] as? String, let pending = commands.removeValue(forKey: id) else { return true }
        let continuation = pending.continuation
        if let status = value["status"] as? Int, (200..<300).contains(status) {
            do { continuation.resume(returning: try JSONSerialization.data(withJSONObject: value["body"] ?? [:])) }
            catch { continuation.resume(throwing: error) }
        } else {
            continuation.resume(throwing: AssistantHTTPError(status: value["status"] as? Int ?? 500,
                code: (value["body"] as? [String: Any])?["error"] as? String ?? "request_failed"))
        }
        return true
    }
    func connect(databaseId: String, identity: KinicIdentitySession, selectedPath: String? = nil, history: [[String: String]] = []) async {
        guard !busy, snapshot == nil, !historyError else { return }
        let principal = identity.principal
        epoch += 1
        let generation = epoch
        busy = true
        boundPrincipal = principal
        boundDatabaseId = databaseId
        error = nil
        defer { if epoch == generation { busy = false } }
        do {
            let data = try await http.data("auth/start", method: "POST", body: ["consent": "2026-09-18", "databaseId": databaseId, "expectedPrincipal": principal])
            guard epoch == generation else { return }
            guard let pending = try JSONSerialization.jsonObject(with: data) as? [String: Any], let token = pending["token"] as? String,
                  let state = pending["state"] as? String else { throw URLError(.cannotParseResponse) }
            try http.setToken(token)
            let response = try authorization.authorize(configuration: configuration, pending: pending, identity: identity)
            guard epoch == generation else { return }
            let authenticated = try await http.data("auth/complete", method: "POST", body: ["state": state, "response": response])
            guard epoch == generation else { return }
            let owner = try JSONSerialization.jsonObject(with: authenticated) as? [String: Any]
            guard owner?["principal"] as? String == principal else { throw AssistantHTTPError(status: 403, code: "identity_changed") }
            var creation: [String: Any] = ["consent": "2026-09-18", "databaseId": databaseId, "scope": scope, "history": history]
            if let selectedPath { creation["selectedPath"] = selectedPath }
            let created = try await http.data("conversations", method: "POST", body: creation)
            guard epoch == generation else { return }
            let metadata = try JSONDecoder().decode(AssistantSnapshot.self, from: created)
            let snapshotState = try await http.snapshot(conversation: metadata.id, metadata: created)
            guard epoch == generation else { return }
            try apply(snapshotState, database: databaseId)
            listen(generation: generation)
        } catch {
            guard epoch == generation else { return }
            self.report(error)
            let revoke = try? http.request("logout", method: "POST")
            http.clearToken()
            if let revoke { _ = try? await http.send(revoke) }
        }
    }
    func report(_ error: Error) {
        failureCode = (error as? AssistantHTTPError)?.code
        self.error = error is URLError ? "Could not communicate with the server. Check your network and retry." : error.localizedDescription
    }
    func clearError() { error = nil; failureCode = nil }
    func waitForControl() async throws {
        for _ in 0..<100 {
            try Task.checkCancellation()
            if controlReady { return }
            guard snapshot != nil else { throw URLError(.cancelled) }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw URLError(.timedOut)
    }
    /// Stop audio immediately; preserve recoverable state until history is durable.
    func finish() async -> Bool {
        guard !finishing else { return false }
#if DEBUG
        if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "voice-preview" { end(); return true }
#endif
        let generation = epoch
        finishing = true
        endingRequested = true
        finalizationWarning = nil
        defer { finishing = false }
        let stoppingID = activeVoiceId ?? snapshot?.voiceId
        stopVoice()
        guard let current = snapshot else { end(); return true }
        do {
            if let principal = boundPrincipal {
                try cache(for: principal).save(principal: principal, snapshot: current, conversationID: historyConversationID, databaseTitle: historyDatabaseTitle)
                try cache(for: principal).markEnding(conversationID: historyConversationID)
            }
            if let stoppingID {
                do { _ = try await http.data("voice/stop", conversation: current.id, method: "POST", body: ["voiceId": stoppingID]) }
                catch let failure as AssistantHTTPError where failure.terminal {
                    finalizationWarning = "The server conversation could not be verified, so the last received content was saved. The final portion may be missing."
                }
            }
            guard epoch == generation else { throw CancellationError() }
            if socket == nil { listen(generation: epoch) }
            do {
                let finalState = try await AssistantVoiceFinalization.waitForStop(conversationID: current.id, databaseID: current.databaseId) { remaining in
                    var request = try http.request("conversation", conversation: current.id)
                    request.timeoutInterval = min(20, remaining)
                    let data = try await http.send(request)
                    guard epoch == generation else { throw CancellationError() }
                    let metadata = try JSONDecoder().decode(AssistantSnapshot.self, from: data)
                    let state = try await http.snapshot(conversation: metadata.id, metadata: data)
                    guard epoch == generation else { throw CancellationError() }
                    try apply(state, database: current.databaseId)
                    return state
                }
                try apply(finalState, database: current.databaseId)
            } catch let failure as AssistantHTTPError where failure.terminal {
                finalizationWarning = "The server conversation could not be verified, so the last received content was saved. The final portion may be missing."
            }
            await historyTask?.value
            guard epoch == generation else { throw CancellationError() }
            guard let latest = snapshot, let saveHistory else { throw URLError(.cannotWriteToFile) }
            try await saveHistory(latest, historyConversationID, historyDatabaseTitle)
            guard epoch == generation else { throw CancellationError() }
            historyError = false
            let principal = boundPrincipal
            eventTask?.cancel(); heartbeat?.cancel(); liveness?.cancel()
            _ = try await http.data("logout", method: "POST")
            guard epoch == generation else { throw CancellationError() }
            if let principal { try cache(for: principal).clear() }
            end(revoke: false)
            return true
        } catch {
            guard epoch == generation else { return false }
            historyError = true
            self.error = "Voice stopped, but saving and ending the conversation could not be completed. Retry."
            return false
        }
    }
    func authenticationUnavailable() {
        error = AssistantHTTPError(status: 401, code: "kinic_session_expired").localizedDescription
    }
    func send() async {
        guard let snapshot, !busy, !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if pendingQuestion == nil { pendingQuestion = (UUID().uuidString.lowercased(), draft) }
        let generation = epoch
        busy = true
        defer { if epoch == generation { busy = false } }
        do {
            try await submitPending(snapshot: snapshot, generation: generation)
        } catch {
            if epoch == generation { self.report(error) }
        }
    }
    private func submitPending(snapshot: AssistantSnapshot, generation: Int) async throws {
        guard let pendingQuestion else { return }
        _ = try await command("questions", body: ["requestId": pendingQuestion.id, "question": pendingQuestion.text, "scope": snapshot.scope], requestId: pendingQuestion.id)
        guard epoch == generation else { return }
        try apply(try await http.snapshot(conversation: snapshot.id), database: snapshot.databaseId)
        self.pendingQuestion = nil
        draft = ""
    }
    func loadQuote() async {
        guard let snapshot, !busy else { return }
        let generation = epoch
        do {
            let data = try await http.data("voice/quote", conversation: snapshot.id)
            guard epoch == generation else { return }
            quote = try JSONDecoder().decode(AssistantQuote.self, from: data)
        } catch { if epoch == generation { self.report(error) } }
    }
    func startVoice(quote: AssistantQuote) async {
        guard let snapshot, !busy, !voiceActive else { return }
        voiceEpoch += 1
        let voiceGeneration = voiceEpoch
        let requestId = UUID().uuidString.lowercased()
        activeVoiceId = requestId
        let generation = epoch
        busy = true
        self.quote = nil
        defer { if epoch == generation { busy = false } }
        do {
            let offer = try await audio.offer()
            guard epoch == generation, voiceEpoch == voiceGeneration else { audio.stop(); return }
            let data = try await command("voice", body: ["sdp": offer, "rateVersion": quote.rateVersion, "requestId": requestId], requestId: requestId)
            guard epoch == generation, voiceEpoch == voiceGeneration else { audio.stop(); return }
            guard let response = try JSONSerialization.jsonObject(with: data) as? [String: Any], let sdp = response["sdp"] as? String else { throw URLError(.cannotParseResponse) }
            try await audio.answer(sdp)
            guard epoch == generation, voiceEpoch == voiceGeneration else { audio.stop(); return }
            try await audio.waitUntilConnected()
            guard epoch == generation, voiceEpoch == voiceGeneration else { audio.stop(); return }
            guard let voiceId = response["voiceId"] as? String else { throw URLError(.cannotParseResponse) }
            _ = try await command("voice/connected", body: ["voiceId": voiceId])
            guard epoch == generation, voiceEpoch == voiceGeneration else { audio.stop(); return }
            try apply(try await http.snapshot(conversation: snapshot.id), database: snapshot.databaseId)
            guard self.snapshot?.voice == "connected", let deadline = self.snapshot?.voiceDeadline else { throw URLError(.cannotParseResponse) }
            voiceActive = true
            audio.activateMicrophone()
            enforceVoiceDeadline(deadline)
        } catch {
            guard epoch == generation, voiceEpoch == voiceGeneration else { return }
            stopVoice()
            self.report(error)
        }
    }
    private func enforceVoiceDeadline(_ deadline: Double) {
        voiceDeadlineTask?.cancel()
        let generation = voiceEpoch
        voiceDeadlineTask = Task { [weak self] in
            let remaining = max(0, deadline / 1000 - Date().timeIntervalSince1970)
            try? await Task.sleep(for: .seconds(remaining))
            guard !Task.isCancelled, let self, voiceEpoch == generation, voiceActive else { return }
            stopVoice()
            error = "Voice stopped because the time limit was reached. Text responses will continue to arrive."
        }
    }
    func stopVoice() {
        voiceEpoch += 1
        voiceDeadlineTask?.cancel()
        audio.stop()
        voiceActive = false
        muted = false
        let voiceId = activeVoiceId
        activeVoiceId = nil
        guard let voiceId, let snapshot, let request = try? http.request("voice/stop", conversation: snapshot.id, method: "POST", body: ["voiceId": voiceId]) else { return }
        let generation = epoch
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await http.send(request) }
            catch { if epoch == generation { self.error = "The microphone stopped. Waiting for the server to finish ending voice." } }
        }
    }
    func toggleMute() { audio.toggleMute(); muted = audio.muted }
    func cancelQuestion() async {
        guard let snapshot else { return }
        let generation = epoch
        do {
            _ = try await command("cancel")
            if epoch == generation {
                try apply(try await http.snapshot(conversation: snapshot.id), database: snapshot.databaseId)
            }
        } catch { if epoch == generation { self.report(error) } }
    }
    func citationChanged(_ citation: AssistantCitation) async throws -> Bool {
        guard let snapshot else { throw CancellationError() }
        let generation = epoch
        let data = try await http.data("citation", conversation: snapshot.id, method: "POST", body: ["citationId": citation.id])
        guard epoch == generation else { throw CancellationError() }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Bool])?["changed"] == true
    }
    func end(revoke: Bool = true) {
        let request = revoke ? (try? http.request("logout", method: "POST")) : nil
        epoch += 1
        voiceEpoch += 1
        voiceDeadlineTask?.cancel()
        audio.stop()
        eventTask?.cancel(); heartbeat?.cancel(); liveness?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        controlReady = false
        activeVoiceId = nil
        rejectCommands()
        boundPrincipal = nil
        boundDatabaseId = nil
        snapshot = nil; quote = nil; pendingQuestion = nil; draft = ""
        endingRequested = false
        voiceActive = false; muted = false; busy = false; reconnecting = false
        disconnectedAt = nil
        http.clearToken()
        if let request { Task { [http] in _ = try? await http.send(request) } }
    }
    func sceneChanged(active: Bool) {
        background = !active
        if !active && !voiceActive {
            rejectCommands()
            disconnectedAt = disconnectedAt ?? Date()
            eventTask?.cancel(); heartbeat?.cancel(); liveness?.cancel()
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
            controlReady = false
        } else if active && snapshot != nil && socket == nil { listen(generation: epoch) }
    }
    private func apply(_ data: Data, database: String) throws {
        let next = try JSONDecoder().decode(AssistantSnapshot.self, from: data)
        try apply(next, database: database)
    }
    private func apply(_ next: AssistantSnapshot, database: String) throws {
        guard next.databaseId == database, snapshot == nil || next.id == snapshot?.id else { throw URLError(.cannotParseResponse) }
        guard AssistantSnapshotOrdering.shouldApply(
            currentRevision: snapshot?.revision,
            incomingRevision: next.revision
        ) else { return }
        snapshot = next
        if let saveHistory {
            pendingHistory = (next, historyConversationID, historyDatabaseTitle, epoch, saveHistory)
            if historyTask == nil {
                historyTask = Task { [weak self] in
                    guard let self else { return }
                    defer { historyTask = nil }
                    while let pending = pendingHistory {
                        pendingHistory = nil
                        do {
                            try await pending.save(pending.snapshot, pending.id, pending.title)
                            if epoch == pending.epoch { historyError = false }
                        } catch {
                            if epoch == pending.epoch {
                                historyError = true
                                self.error = "The conversation could not be saved. It will be retried when you end it."
                            }
                        }
                    }
                }
            }
        }
        if let boundPrincipal { try cache(for: boundPrincipal).save(principal: boundPrincipal, snapshot: next, conversationID: historyConversationID, databaseTitle: historyDatabaseTitle) }
        if next.voice == "off" || next.voice == "stopping" {
            if voiceActive || next.voice == "stopping" { voiceEpoch += 1; voiceDeadlineTask?.cancel(); audio.stop(); voiceActive = false; muted = false }
        } else if voiceActive, let deadline = next.voiceDeadline {
            enforceVoiceDeadline(deadline)
        }
        if let code = next.error { error = AssistantHTTPError(status: 400, code: code).localizedDescription }
        if let pendingQuestion, next.messages.contains(where: { $0.requestId == pendingQuestion.id }) { self.pendingQuestion = nil; draft = "" }
    }
    private func listen(generation: Int) {
        controlReady = false
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, epoch == generation, let current = snapshot {
                if let disconnectedAt, Date().timeIntervalSince(disconnectedAt) * 1000 >= Double(current.reconnectGraceMs) {
                    end(); error = "The reconnection window expired. Start the conversation again."; return
                }
                do {
                    let status = try await http.snapshot(conversation: current.id)
                    guard epoch == generation, !Task.isCancelled else { return }
                    try apply(status, database: current.databaseId)
                    var request = try http.request("events", conversation: current.id)
                    var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                    url.scheme = "wss"; request.url = url.url
                    let ws = URLSession.shared.webSocketTask(with: request)
                    ws.maximumMessageSize = 1_000_000
                    socket = ws; ws.resume()
                    lastReceivedAt = Date()
                    heartbeat?.cancel()
                    heartbeat = Task { [weak self] in
                        while !Task.isCancelled, self?.epoch == generation {
                            try? await Task.sleep(for: .seconds(AssistantLiveness.heartbeatSeconds))
                            guard !Task.isCancelled else { return }
                            let packet = AssistantLiveness.heartbeatRequest(id: UUID().uuidString.lowercased())
                            do { try await ws.send(.string(packet)) } catch { return }
                        }
                    }
                    liveness?.cancel()
                    liveness = Task { [weak self] in
                        while !Task.isCancelled {
                            try? await Task.sleep(for: .seconds(AssistantLiveness.heartbeatSeconds))
                            guard !Task.isCancelled, let self, epoch == generation else { return }
                            guard AssistantLiveness.shouldReconnect(lastReceivedAt: lastReceivedAt, now: Date()) else { continue }
                            // Cancel the socket so `receive()` fails and the loop below
                            // reconnects through the existing error path.
                            socket?.cancel(with: .goingAway, reason: nil)
                            return
                        }
                    }
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        guard epoch == generation, !Task.isCancelled else { return }
                        lastReceivedAt = Date()
                        let data: Data
                        switch message { case .string(let text): data = Data(text.utf8); case .data(let value): data = value; @unknown default: continue }
                        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                        if try receiveCommand(value) { continue }
                        // A heartbeat reply only proves liveness; it is not a snapshot.
                        if AssistantLiveness.isHeartbeatReply(value) { continue }
                        if value["type"] as? String == "ended" {
                            if !finishing { end(); error = "This conversation connection has ended." }
                            return
                        }
                        guard let revision = value["revision"] as? Int else { throw URLError(.cannotParseResponse) }
                        if revision > (snapshot?.revision ?? -1) {
                            let state = try await http.snapshot(conversation: current.id)
                            guard epoch == generation, !Task.isCancelled else { return }
                            try apply(state, database: current.databaseId)
                        }
                        controlReady = true
                        disconnectedAt = nil; reconnecting = false
                        if pendingQuestion != nil, !retryingQuestion {
                            retryingQuestion = true
                            Task { [weak self] in
                                guard let self else { return }
                                defer { retryingQuestion = false }
                                do { try await submitPending(snapshot: current, generation: generation) }
                                catch { if epoch == generation { self.report(error) } }
                            }
                        }
                    }
                } catch {
                    guard epoch == generation, !Task.isCancelled else { return }
                    if let error = error as? AssistantHTTPError, error.terminal {
                        if !finishing { end(); self.report(error) }
                        return
                    }
                    controlReady = false
                    rejectCommands()
                    heartbeat?.cancel(); liveness?.cancel(); socket?.cancel(with: .goingAway, reason: nil); socket = nil
                    if voiceActive { stopVoice() }
                    disconnectedAt = disconnectedAt ?? Date(); reconnecting = true
                    if background { return }
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }
}
