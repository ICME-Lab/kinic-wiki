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
final class AssistantConversationModel {
    private(set) var snapshot: AssistantSnapshot?
    private(set) var error: String?
    private(set) var failureCode: String?
    private(set) var busy = false
    private(set) var reconnecting = false
    var historyConversationID = UUID()
    var historyDatabaseTitle = ""
    private(set) var endingRequested = false
    private(set) var controlReady = false
    var scope = "database"
    let configuration: AppConfiguration
    @ObservationIgnored private let http: any AssistantHTTPProviding
    @ObservationIgnored private let authorization = AssistantNativeAuthorization()
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var heartbeat: Task<Void, Never>?
    @ObservationIgnored private var liveness: Task<Void, Never>?
    @ObservationIgnored private var lastReceivedAt: Date?
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var disconnectedAt: Date?
    @ObservationIgnored private var background = false
    @ObservationIgnored private let applicationSupportDirectory: URL
    // Keep text recovery separate so retiring voice data never deletes current text recovery.
    private func cache(for principal: String) -> AssistantConversationCache {
        let namespace = SHA256.hash(data: Data((configuration.canisterId + ":" + principal).utf8)).map { String(format: "%02x", $0) }.joined()
        return AssistantConversationCache(directory: applicationSupportDirectory.appending(path: "AssistantHistoryRecovery/" + namespace, directoryHint: .isDirectory))
    }
    @ObservationIgnored private var boundPrincipal: String?
    @ObservationIgnored private var boundDatabaseId: String?
    @ObservationIgnored private var commands: [String: (attempt: UUID, continuation: CheckedContinuation<Data, Error>)] = [:]
    init(configuration: AppConfiguration, http: (any AssistantHTTPProviding)? = nil,
         applicationSupportDirectory: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]) {
        self.configuration = configuration
        self.http = http ?? AssistantHTTPClient(configuration: configuration)
        self.applicationSupportDirectory = applicationSupportDirectory
        do {
            try AssistantConversationCache.discardRetiredVoiceRecovery(in: applicationSupportDirectory)
        } catch {
            self.error = "Old voice recovery data could not be removed. Reopen the app to retry."
        }
    }
#if DEBUG
    func loadScreenshotFixture() {
        let text = """
        {"revision":1,"id":"preview","databaseId":"demo","scope":"/Knowledge","status":"ready","error":null,"generation":1,"reconnectGraceMs":120000,"voice":"off","progress":null,"utterances":[],"messages":[{"voice":false,"requestId":"example","question":"What does this Wiki say?","error":null,"answer":{"answer":"This answer is grounded in the selected Wiki.","citations":[{"id":"source","databaseId":"demo","path":"/Knowledge/Overview","excerpt":"A short verified source excerpt.","etag":"v1"}],"insufficient":false,"contradictions":[],"unverified":[]}}]}
        """
        snapshot = try? JSONDecoder().decode(AssistantSnapshot.self, from: Data(text.utf8))
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
        guard !busy, snapshot == nil else { return }
        let principal = identity.principal
        epoch += 1
        let generation = epoch
        busy = true
        boundPrincipal = principal
        boundDatabaseId = databaseId
        error = nil
        defer { if epoch == generation { busy = false } }
        do {
            // Retry a startup cleanup failure before creating another conversation.
            try AssistantConversationCache.discardRetiredVoiceRecovery(in: applicationSupportDirectory)
            let data = try await http.data("auth/start", method: "POST", body: ["consent": "2026-09-29", "databaseId": databaseId, "expectedPrincipal": principal])
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
            var creation: [String: Any] = ["consent": "2026-09-29", "databaseId": databaseId, "scope": scope, "history": history]
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
        let generation = epoch
        for _ in 0..<100 {
            try Task.checkCancellation()
            guard epoch == generation, snapshot != nil else { throw CancellationError() }
            if controlReady { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw URLError(.timedOut)
    }
    func askText(
        _ question: String,
        subject: [String: String] = ["kind": "database"]
    ) async throws -> AssistantMessage {
        guard let snapshot, !busy else {
            throw AssistantHTTPError(status: 409, code: "turn_in_progress")
        }
        let requestID = UUID().uuidString.lowercased()
        let generation = epoch
        busy = true
        defer { if epoch == generation { busy = false } }
        // Conversation creation starts the socket listener asynchronously. Wait
        // for its first snapshot before sending, including during reconnection.
        try await waitForControl()
        guard epoch == generation else { throw CancellationError() }
        _ = try await command(
            "questions",
            body: [
                "requestId": requestID,
                "question": question,
                "scope": snapshot.scope,
                "subject": subject,
            ],
            requestId: requestID
        )
        let deadline = ProcessInfo.processInfo.systemUptime + 95
        while ProcessInfo.processInfo.systemUptime < deadline {
            try Task.checkCancellation()
            guard epoch == generation else { throw CancellationError() }
            let next = try await refreshSnapshot(snapshot)
            if let message = next.messages.first(where: { $0.requestId == requestID }) {
                if let code = message.error {
                    throw AssistantHTTPError(status: 503, code: code)
                }
                if message.answer != nil { return message }
            }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw URLError(.timedOut)
    }
    func cancelQuestionAndWait() async throws {
        guard let snapshot else { return }
        let generation = epoch
        _ = try await command("cancel")
        guard epoch == generation else { throw CancellationError() }
        _ = try await refreshSnapshot(snapshot)
    }
    func refreshSnapshot(_ current: AssistantSnapshot) async throws -> AssistantSnapshot {
        let generation = epoch
        guard snapshot?.id == current.id else { throw CancellationError() }
        let next = try await http.snapshot(conversation: current.id)
        try Task.checkCancellation()
        guard epoch == generation else { throw CancellationError() }
        try apply(next, database: current.databaseId)
        return next
    }
    func endAndRevoke() async throws {
        let generation = epoch
        guard let snapshot else {
            if http.hasToken, let revoke = try? http.request("logout", method: "POST") {
                _ = try await http.send(revoke)
            }
            guard epoch == generation else { throw CancellationError() }
            end(revoke: false)
            return
        }
        let previousBusy = busy
        busy = true
        endingRequested = true
        do {
            _ = try await http.data("end", conversation: snapshot.id, method: "POST")
            guard epoch == generation else { throw CancellationError() }
            if let revoke = try? http.request("logout", method: "POST") {
                _ = try? await http.send(revoke)
            }
            guard epoch == generation else { throw CancellationError() }
            end(revoke: false)
        } catch {
            if epoch == generation {
                busy = previousBusy
                endingRequested = false
            }
            throw error
        }
    }
    func receiveEndNotification() {
        controlReady = false
        // The HTTP end operation owns teardown when we requested this event.
        guard !endingRequested else { return }
        end()
        error = "This conversation connection has ended."
    }
    func end(revoke: Bool = true) {
        let request = revoke ? (try? http.request("logout", method: "POST")) : nil
        epoch += 1
        eventTask?.cancel(); heartbeat?.cancel(); liveness?.cancel()
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        controlReady = false
        rejectCommands()
        boundPrincipal = nil
        boundDatabaseId = nil
        snapshot = nil
        endingRequested = false
        busy = false; reconnecting = false
        disconnectedAt = nil
        http.clearToken()
        if let request { Task { [http] in _ = try? await http.send(request) } }
    }
    func sceneChanged(active: Bool) {
        background = !active
        if !active {
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
        if let boundPrincipal { try cache(for: boundPrincipal).save(principal: boundPrincipal, snapshot: next, conversationID: historyConversationID, databaseTitle: historyDatabaseTitle) }
        if let code = next.error { error = AssistantHTTPError(status: 400, code: code).localizedDescription }
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
                            receiveEndNotification()
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
                    }
                } catch {
                    guard epoch == generation, !Task.isCancelled else { return }
                    if let error = error as? AssistantHTTPError, error.terminal {
                        guard !endingRequested else { return }
                        end(); self.report(error)
                        return
                    }
                    controlReady = false
                    rejectCommands()
                    heartbeat?.cancel(); liveness?.cancel(); socket?.cancel(with: .goingAway, reason: nil); socket = nil
                    disconnectedAt = disconnectedAt ?? Date(); reconnecting = true
                    if background { return }
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }
}
