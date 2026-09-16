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
}
struct AssistantMessage: Codable, Identifiable, Sendable {
    let requestId: String
    var id: String { requestId }
    let question: String
    let answer: AssistantAnswer?
    let error: String?
}
struct AssistantSnapshot: Codable, Sendable {
    let id: String
    let databaseId: String
    let scope: String
    let status: String
    let error: String?
    let generation: Int
    let reconnectGraceMs: Int
    let messages: [AssistantMessage]
    let voice: String
    let voiceDeadline: Double?
    let voiceId: String?
    let progress: Progress?
    struct Progress: Codable, Sendable { let calls: Int; let stage: String }
}
struct AssistantQuote: Codable, Sendable {
    let rateVersion: String
    let cyclesPerMinute: String
    let maximumCycles: String
    let maximumSeconds: Int
}
struct AssistantHTTPError: LocalizedError {
    let status: Int
    let code: String
    var terminal: Bool { [401, 403, 404, 410].contains(status) || code == "assistant_disabled" }
    var errorDescription: String? {
        switch code {
        case "assistant_disabled": "Voice preview is not available."
        case "assistant_not_configured": "Voice preview is not configured on the server."
        case "voice_permission_required": "The database owner must allow your preview access."
        case "database_access_denied": "Your Kinic account cannot read this database."
        case "kinic_session_expired": "Your Kinic sign-in has expired. Sign in again, then reconnect the preview."
        case "choose_questions_only", "invalid_delegation", "invalid_delegation_key", "invalid_delegation_target", "invalid_delegation_expiry": "The preview could not verify your read-only Kinic permission. Sign in again and retry."
        case "identity_changed": "Use the same Internet Identity account as your Wiki sign-in."
        case "voice_connection_failed": "The voice connection failed. You can continue this conversation with text."
        case "voice_close_pending": "Voice is stopping. Your text answer can still arrive."
        case "microphone_denied": "Microphone access was denied. Enable it in Settings or continue with text."
        case "voice_billing_not_configured": "Voice pricing is not configured yet."
        case "voice_price_consent_required": "Review the connection price before starting voice."
        case "authentication_required": "Your preview authorization expired. Connect again."
        case "voice_billing_denied", "voice_budget_exhausted": "Voice stopped because the available budget could not be reserved."
        case "rate_limit": "Too many preview connection attempts. Wait a moment and try again."
        default: "The preview request failed. Please try again."
        }
    }
}
