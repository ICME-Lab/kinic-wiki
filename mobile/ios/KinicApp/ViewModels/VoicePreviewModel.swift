import Foundation
import Observation

@MainActor @Observable
final class VoicePreviewModel {
    private(set) var snapshot: AssistantSnapshot?
    private(set) var error: String?
    private(set) var busy = false
    private(set) var voiceActive = false
    private(set) var muted = false
    private(set) var reconnecting = false
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
    @ObservationIgnored private var voiceDeadlineTask: Task<Void, Never>?
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var voiceEpoch = 0
    @ObservationIgnored private var activeVoiceId: String?
    @ObservationIgnored private var disconnectedAt: Date?
    @ObservationIgnored private var pendingQuestion: (id: String, text: String)?
    @ObservationIgnored private var background = false
    @ObservationIgnored private let cache = AssistantConversationCache()
    @ObservationIgnored private var boundPrincipal: String?
    @ObservationIgnored private var boundDatabaseId: String?
    @ObservationIgnored private var commands: [String: (attempt: UUID, continuation: CheckedContinuation<Data, Error>)] = [:]
    @ObservationIgnored private var retryingQuestion = false
    init(configuration: AppConfiguration) {
        self.configuration = configuration
        http = AssistantHTTPClient(configuration: configuration)
        audio.onFailure = { [weak self] in
            self?.stopVoice()
            self?.error = "Voice stopped after an audio interruption. Your answer can still arrive as text."
        }
    }
#if DEBUG
    func loadScreenshotFixture() {
        let text = """
        {"id":"preview","databaseId":"demo","scope":"/Knowledge","status":"ready","error":null,"generation":1,"reconnectGraceMs":120000,"voice":"off","progress":null,"messages":[{"requestId":"example","question":"What does this Wiki say?","error":null,"answer":{"answer":"This answer is grounded in the selected Wiki.","citations":[{"id":"source","databaseId":"demo","path":"/Knowledge/Overview","excerpt":"A short verified source excerpt.","etag":"v1"}],"insufficient":false,"contradictions":[],"unverified":[]}}]}
        """
        snapshot = try? JSONDecoder().decode(AssistantSnapshot.self, from: Data(text.utf8))
        boundPrincipal = "owner"
        boundDatabaseId = "demo"
    }
#endif
    func contextChanged(databaseId: String, principal: String) {
        if let boundPrincipal, let boundDatabaseId {
            if boundPrincipal != principal || boundDatabaseId != databaseId { end() }
            return
        }
        if boundPrincipal != nil || boundDatabaseId != nil || snapshot != nil { end(); return }
        guard !principal.isEmpty, !databaseId.isEmpty else { return }
        do {
            if let saved = try cache.load(), saved.principal != principal || saved.snapshot.databaseId != databaseId { end() }
        } catch { end() }
    }
    func restore(databaseId: String, principal: String) async {
        guard !busy, snapshot == nil, !principal.isEmpty else { return }
        do {
            guard let saved = try cache.load() else { return }
            guard saved.principal == principal, saved.snapshot.databaseId == databaseId else { end(); return }
            epoch += 1
            let generation = epoch
            busy = true
            defer { if epoch == generation { busy = false } }
            let auth = try await http.data("auth")
            guard epoch == generation else { return }
            guard (try JSONSerialization.jsonObject(with: auth) as? [String: Any])?["principal"] as? String == principal else {
                throw AssistantHTTPError(status: 403, code: "identity_changed")
            }
            let state = try await http.data("conversation", conversation: saved.snapshot.id)
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
            self.error = error.localizedDescription
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
    func connect(databaseId: String, principal: String, selectedPath: String? = nil) async {
        guard !busy, snapshot == nil else { return }
        epoch += 1
        let generation = epoch
        busy = true
        boundPrincipal = principal
        boundDatabaseId = databaseId
        error = nil
        defer { if epoch == generation { busy = false } }
        do {
            let data = try await http.data("auth/start", method: "POST", body: ["consent": "2026-09-14", "databaseId": databaseId, "expectedPrincipal": principal])
            guard epoch == generation else { return }
            guard let pending = try JSONSerialization.jsonObject(with: data) as? [String: Any], let token = pending["token"] as? String,
                  let state = pending["state"] as? String else { throw URLError(.cannotParseResponse) }
            try http.setToken(token)
            let response = try await authorization.authorize(configuration: configuration, pending: pending)
            guard epoch == generation else { return }
            let authenticated = try await http.data("auth/complete", method: "POST", body: ["state": state, "response": response])
            guard epoch == generation else { return }
            let owner = try JSONSerialization.jsonObject(with: authenticated) as? [String: Any]
            guard owner?["principal"] as? String == principal else { throw AssistantHTTPError(status: 403, code: "identity_changed") }
            var creation: [String: Any] = ["consent": "2026-09-14", "databaseId": databaseId, "scope": scope]
            if let selectedPath { creation["selectedPath"] = selectedPath }
            let created = try await http.data("conversations", method: "POST", body: creation)
            guard epoch == generation else { return }
            try apply(created, database: databaseId)
            listen(generation: generation)
        } catch {
            guard epoch == generation else { return }
            self.error = error.localizedDescription
            let revoke = try? http.request("logout", method: "POST")
            http.clearToken()
            if let revoke { _ = try? await http.send(revoke) }
        }
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
            if epoch == generation { self.error = error.localizedDescription }
        }
    }
    private func submitPending(snapshot: AssistantSnapshot, generation: Int) async throws {
        guard let pendingQuestion else { return }
        let data = try await command("questions", body: ["requestId": pendingQuestion.id, "question": pendingQuestion.text, "scope": snapshot.scope], requestId: pendingQuestion.id)
        guard epoch == generation else { return }
        try apply(data, database: snapshot.databaseId)
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
        } catch { if epoch == generation { self.error = error.localizedDescription } }
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
            let connected = try await command("voice/connected", body: ["voiceId": voiceId])
            guard epoch == generation, voiceEpoch == voiceGeneration else { audio.stop(); return }
            try apply(connected, database: snapshot.databaseId)
            guard self.snapshot?.voice == "connected", let deadline = self.snapshot?.voiceDeadline else { throw URLError(.cannotParseResponse) }
            voiceActive = true
            audio.activateMicrophone()
            enforceVoiceDeadline(deadline)
        } catch {
            guard epoch == generation, voiceEpoch == voiceGeneration else { return }
            stopVoice()
            self.error = error.localizedDescription
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
            error = "Voice stopped at the reserved time limit. Your text answer can still arrive."
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
            catch { if epoch == generation { self.error = "Voice stopped locally. Waiting for server cleanup." } }
        }
    }
    func toggleMute() { audio.toggleMute(); muted = audio.muted }
    func cancelQuestion() async {
        guard let snapshot else { return }
        let generation = epoch
        do {
            let data = try await command("cancel")
            if epoch == generation { try apply(data, database: snapshot.databaseId) }
        } catch { if epoch == generation { self.error = error.localizedDescription } }
    }
    func citationChanged(_ citation: AssistantCitation) async throws -> Bool {
        guard let snapshot else { throw CancellationError() }
        let generation = epoch
        let data = try await http.data("citation", conversation: snapshot.id, method: "POST", body: ["citationId": citation.id])
        guard epoch == generation else { throw CancellationError() }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Bool])?["changed"] == true
    }
    func end() {
        let request = try? http.request("logout", method: "POST")
        epoch += 1
        voiceEpoch += 1
        voiceDeadlineTask?.cancel()
        authorization.cancel()
        audio.stop()
        eventTask?.cancel(); heartbeat?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        activeVoiceId = nil
        rejectCommands()
        boundPrincipal = nil
        boundDatabaseId = nil
        do { try cache.clear() } catch { self.error = "Unable to remove the preview cache." }
        snapshot = nil; quote = nil; pendingQuestion = nil; draft = ""
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
            eventTask?.cancel(); heartbeat?.cancel()
            socket?.cancel(with: .goingAway, reason: nil)
            socket = nil
        } else if active && snapshot != nil && socket == nil { listen(generation: epoch) }
    }
    private func apply(_ data: Data, database: String) throws {
        let next = try JSONDecoder().decode(AssistantSnapshot.self, from: data)
        guard next.databaseId == database, snapshot == nil || next.id == snapshot?.id else { throw URLError(.cannotParseResponse) }
        if let snapshot, next.generation < snapshot.generation { return }
        snapshot = next
        if let boundPrincipal { try cache.save(principal: boundPrincipal, snapshot: next) }
        if next.voice == "off" || next.voice == "stopping" {
            if voiceActive || next.voice == "stopping" { voiceEpoch += 1; voiceDeadlineTask?.cancel(); audio.stop(); voiceActive = false; muted = false }
        } else if voiceActive, let deadline = next.voiceDeadline {
            enforceVoiceDeadline(deadline)
        }
        if let code = next.error { error = AssistantHTTPError(status: 400, code: code).localizedDescription }
        if let pendingQuestion, next.messages.contains(where: { $0.requestId == pendingQuestion.id }) { self.pendingQuestion = nil; draft = "" }
    }
    private func listen(generation: Int) {
        eventTask?.cancel()
        eventTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, epoch == generation, let current = snapshot {
                if let disconnectedAt, Date().timeIntervalSince(disconnectedAt) * 1000 >= Double(current.reconnectGraceMs) {
                    end(); error = "The reconnect window expired. Start a new conversation."; return
                }
                do {
                    let status = try await http.data("conversation", conversation: current.id)
                    guard epoch == generation, !Task.isCancelled else { return }
                    try apply(status, database: current.databaseId)
                    var request = try http.request("events", conversation: current.id)
                    var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
                    url.scheme = "wss"; request.url = url.url
                    let ws = URLSession.shared.webSocketTask(with: request)
                    ws.maximumMessageSize = 1_000_000
                    socket = ws; ws.resume()
                    heartbeat?.cancel()
                    heartbeat = Task { [weak self] in
                        while !Task.isCancelled, self?.epoch == generation {
                            try? await Task.sleep(for: .seconds(10))
                            guard !Task.isCancelled else { return }
                            do { try await ws.send(.string("heartbeat")) } catch { return }
                        }
                    }
                    while !Task.isCancelled {
                        let message = try await ws.receive()
                        guard epoch == generation, !Task.isCancelled else { return }
                        let data: Data
                        switch message { case .string(let text): data = Data(text.utf8); case .data(let value): data = value; @unknown default: continue }
                        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
                        if try receiveCommand(value) { continue }
                        if value["type"] as? String == "ended" {
                            end(); error = "This conversation has ended."; return
                        }
                        try apply(data, database: current.databaseId)
                        disconnectedAt = nil; reconnecting = false
                        if pendingQuestion != nil, !retryingQuestion {
                            retryingQuestion = true
                            Task { [weak self] in
                                guard let self else { return }
                                defer { retryingQuestion = false }
                                do { try await submitPending(snapshot: current, generation: generation) }
                                catch { if epoch == generation { self.error = error.localizedDescription } }
                            }
                        }
                    }
                } catch {
                    guard epoch == generation, !Task.isCancelled else { return }
                    if let error = error as? AssistantHTTPError, error.terminal {
                        end(); self.error = error.localizedDescription; return
                    }
                    rejectCommands()
                    heartbeat?.cancel(); socket?.cancel(with: .goingAway, reason: nil); socket = nil
                    if voiceActive { stopVoice() }
                    disconnectedAt = disconnectedAt ?? Date(); reconnecting = true
                    if background { return }
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }
}
