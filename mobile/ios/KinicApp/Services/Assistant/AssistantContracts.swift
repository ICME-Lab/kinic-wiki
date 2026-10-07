import Foundation

struct AssistantCitation: Codable, Identifiable, Sendable {
    let id: String
    let databaseId: String
    let path: String
    let excerpt: String
    let etag: String
}
struct AssistantAnswer: Codable, Sendable {
    let answer: String
    let citations: [AssistantCitation]
    let insufficient: Bool
    let contradictions: [String]
    let unverified: [String]
    var displayText: String {
        var parts = [answer]
        if insufficient { parts.append("There is not enough supporting evidence.") }
        if !contradictions.isEmpty { parts.append("Conflicting information\n" + contradictions.map { "• " + $0 }.joined(separator: "\n")) }
        if !unverified.isEmpty { parts.append("Unverified information\n" + unverified.map { "• " + $0 }.joined(separator: "\n")) }
        return parts.joined(separator: "\n\n")
    }
}
struct AssistantMessage: Codable, Identifiable, Sendable {
    let voice: Bool
    let requestId: String
    var id: String { requestId }
    let question: String
    let answer: AssistantAnswer?
    let error: String?
    let kind: String?
    let trace: AssistantRetrievalTrace?
}
struct AssistantRetrievalTrace: Codable, Sendable {
    let route: String
    let calls: Int
    let characters: Int
    let inventoryObserved: Int
    let inventoryTruncated: Bool
    let readCount: Int
    let jevRouteDurationMs: Int
    let jevRerankDurationMs: Int
}
struct AssistantUtterance: Codable, Identifiable, Sendable {
    let id: String
    let role: String
    let text: String
}
struct AssistantSnapshot: Codable, Sendable {
    let revision: Int
    let id: String
    let databaseId: String
    let scope: String
    let status: String
    let error: String?
    let generation: Int
    let reconnectGraceMs: Int
    let messages: [AssistantMessage]
    let utterances: [AssistantUtterance]
    let voice: String
    let voiceDeadline: Double?
    let voiceId: String?
    let progress: Progress?
    struct Progress: Codable, Sendable { let calls: Int; let stage: String }
    init(revision: Int, id: String, databaseId: String, scope: String, status: String,
         error: String?, generation: Int, reconnectGraceMs: Int,
         messages: [AssistantMessage], utterances: [AssistantUtterance], voice: String,
         voiceDeadline: Double?, voiceId: String?, progress: Progress?) {
        self.revision = revision
        self.id = id
        self.databaseId = databaseId
        self.scope = scope
        self.status = status
        self.error = error
        self.generation = generation
        self.reconnectGraceMs = reconnectGraceMs
        self.messages = messages
        self.utterances = utterances
        self.voice = voice
        self.voiceDeadline = voiceDeadline
        self.voiceId = voiceId
        self.progress = progress
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        revision = try values.decode(Int.self, forKey: .revision)
        id = try values.decode(String.self, forKey: .id)
        databaseId = try values.decode(String.self, forKey: .databaseId)
        scope = try values.decode(String.self, forKey: .scope)
        status = try values.decode(String.self, forKey: .status)
        error = try values.decodeIfPresent(String.self, forKey: .error)
        generation = try values.decode(Int.self, forKey: .generation)
        reconnectGraceMs = try values.decode(Int.self, forKey: .reconnectGraceMs)
        messages = try values.decodeIfPresent([AssistantMessage].self, forKey: .messages) ?? []
        utterances = try values.decodeIfPresent([AssistantUtterance].self, forKey: .utterances) ?? []
        voice = try values.decode(String.self, forKey: .voice)
        voiceDeadline = try values.decodeIfPresent(Double.self, forKey: .voiceDeadline)
        voiceId = try values.decodeIfPresent(String.self, forKey: .voiceId)
        progress = try values.decodeIfPresent(Progress.self, forKey: .progress)
    }
    func withHistory(messages: [AssistantMessage], utterances: [AssistantUtterance]) -> Self {
        Self(revision: revision, id: id, databaseId: databaseId, scope: scope,
             status: status, error: error, generation: generation,
             reconnectGraceMs: reconnectGraceMs, messages: messages,
             utterances: utterances, voice: voice, voiceDeadline: voiceDeadline,
             voiceId: voiceId, progress: progress)
    }
}
struct AssistantHistoryPage: Codable, Sendable {
    let revision: Int
    let messages: [AssistantMessage]
    let utterances: [AssistantUtterance]
    let nextCursor: String?
}
enum AssistantSnapshotOrdering {
    static func shouldApply(currentRevision: Int?, incomingRevision: Int) -> Bool {
        currentRevision.map { incomingRevision > $0 } ?? true
    }
}
struct AssistantHTTPError: LocalizedError {
    let status: Int
    let code: String
    var terminal: Bool { [401, 403, 404, 410].contains(status) || code == "assistant_disabled" }
    var errorDescription: String? {
        switch code {
        case "assistant_disabled": "Ask AI is currently unavailable."
        case "assistant_not_configured": "The Ask AI service has not been configured."
        case "consent_required": "Reconnect to update your Ask AI session and retry."
        case "deepseek_request_interrupted": "The answer request was interrupted. Send the question again to retry."
        case "deepseek_unavailable", "deepseek_timeout", "deepseek_request_failed", "deepseek_invalid_response", "deepseek_response_too_large": "Could not generate the answer. Try again."
        case "jev_unavailable": "Semantic routing is temporarily unavailable. Try again."
        case "turn_in_progress": "Ask AI is already processing a question."
        case "connection_already_active": "Ask AI is restoring the connection. Wait a moment and retry."
        case "wiki_read_denied": "Your database access could not be verified. Reconnect and retry."
        case "turn_timeout": "The answer took too long. Try a narrower question."
        case "stale_state": "The conversation changed while loading. Retry."
        case "invalid_citation", "unsupported_answer": "The answer could not be verified against your notes. Retry."
        case "context_limit", "tool_limit", "overview_read_limit", "empty_excerpt_or_budget": "This question needs more information than one answer can process. Try a narrower question."
        case "database_access_denied": "You do not have permission to view this database."
        case "kinic_session_expired": "Your sign-in session expired. Sign in again."
        case "choose_questions_only", "invalid_delegation", "invalid_delegation_key", "invalid_delegation_target", "invalid_delegation_expiry": "Your access could not be verified. Sign in again and retry."
        case "identity_changed": "Use the same account that you used to sign in to the Wiki."
        case "authentication_required": "Ask AI authentication expired. Reconnect and retry."
        case "rate_limit": "The connection limit has been reached. Wait a moment and retry."
        default: "Ask AI processing failed. Retry."
        }
    }
}

/// Keep the complete JSON request below the Worker's 64 KiB body limit,
/// including multi-byte text and JSON escaping.
enum AssistantHistoryContext {
    static func make(_ messages: [AskAIMessage]) -> [[String: String]] {
        var result: [[String: String]] = []
        for message in messages.suffix(20).reversed() {
            guard !message.text.isEmpty else { continue }
            let characters = Array(message.text.prefix(4000))
            let role = message.role == .user ? "user" : "assistant"
            var lower = 0, upper = characters.count
            // The Worker counts UTF-16 code units; JSON also has a total byte
            // limit. Keep the largest whole-character prefix satisfying both.
            while lower < upper {
                let middle = (lower + upper + 1) / 2
                let text = String(characters.prefix(middle))
                let candidate = [["role": role, "text": text]] + result
                if text.utf16.count <= 4000,
                   let data = try? JSONSerialization.data(withJSONObject: candidate), data.count <= 12000 {
                    lower = middle
                } else { upper = middle - 1 }
            }
            guard lower > 0 else { break }
            result.insert(["role": role, "text": String(characters.prefix(lower))], at: 0)
        }
        return result
    }
}

/// Bound visible characters and the Worker's UTF-16 limit without splitting a grapheme.
enum AskAIQuestionLimit {
    static let maximumUTF16Units = 4_000

    static func contains(_ text: String) -> Bool {
        text.count <= AskAIRouter.maximumQuestionCharacters && text.utf16.count <= maximumUTF16Units
    }

    static func prefix(_ text: String) -> String {
        var result = ""
        var units = 0
        for character in text.prefix(AskAIRouter.maximumQuestionCharacters) {
            let value = String(character)
            let count = value.utf16.count
            guard units + count <= maximumUTF16Units else { break }
            result.append(character)
            units += count
        }
        return result
    }
}
