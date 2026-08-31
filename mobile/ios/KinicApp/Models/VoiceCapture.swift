// Where: mobile/ios/KinicApp/Models/VoiceCapture.swift
// What: Durable voice capture draft and Markdown contracts.
// Why: Dictation and local voice memos share identity, storage, and VFS metadata without sharing audio.

import Foundation

enum VoiceCaptureMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case dictation
    case voiceMemo = "voice_memo"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .dictation:
            "Voice Note"
        case .voiceMemo:
            "Voice Memo"
        }
    }

    var maximumDuration: TimeInterval {
        switch self {
        case .dictation:
            5 * 60
        case .voiceMemo:
            30 * 60
        }
    }

    var audioRetention: String {
        switch self {
        case .dictation:
            "none"
        case .voiceMemo:
            "device_local"
        }
    }
}

enum VoiceCaptureAccountScope: Codable, Equatable, Sendable {
    case guest
    case principal(String)

    var principal: String? {
        guard case let .principal(principal) = self else { return nil }
        return principal
    }
}

struct VoiceCaptureRequest: Identifiable, Equatable, Sendable {
    let id: UUID
    let mode: VoiceCaptureMode

    init(id: UUID = UUID(), mode: VoiceCaptureMode) {
        self.id = id
        self.mode = mode
    }
}

struct VoiceCaptureDraft: Codable, Identifiable, Equatable, Sendable {
    let id: UUID
    let mode: VoiceCaptureMode
    let scope: VoiceCaptureAccountScope
    let capturedAt: Date
    var title: String
    var transcript: String
    var language: WikiOutputLanguage
    var durationMilliseconds: Int64
    var databaseId: String?
    var audioFilename: String?
    var kinicPath: String?

    var hasAudio: Bool {
        audioFilename?.isEmpty == false
    }
}

struct VoiceCaptureDocument: Equatable, Sendable {
    static let directoryPath = "/Knowledge/Inbox/Voice Notes"

    let path: String
    let content: String
    let metadataJson: String

    static func make(from draft: VoiceCaptureDraft, title: String, transcript: String) throws -> VoiceCaptureDocument {
        let normalizedTitle = title
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedTitle.isEmpty else {
            throw VoiceCaptureDocumentError.emptyTitle
        }
        guard !normalizedTranscript.isEmpty else {
            throw VoiceCaptureDocumentError.emptyTranscript
        }

        let timestamp = makeFilenameTimestampFormatter().string(from: draft.capturedAt)
        let shortId = draft.id.uuidString.lowercased().prefix(8)
        let path = "\(directoryPath)/\(timestamp)-\(shortId).md"
        let capturedAt = ISO8601DateFormatter().string(from: draft.capturedAt)
        let duration = Self.durationLabel(milliseconds: draft.durationMilliseconds)
        let content = """
        # \(normalizedTitle)

        - Captured: \(capturedAt)
        - Duration: \(duration)
        - Language: \(draft.language.rawValue)
        - Capture mode: \(draft.mode.rawValue)
        - Audio retention: \(draft.mode.audioRetention)

        ## Transcript

        \(normalizedTranscript)
        """
        let metadata = VoiceCaptureMetadata(
            kind: "kinic.voice_note",
            version: 1,
            voiceNoteId: draft.id.uuidString.lowercased(),
            capturedAt: capturedAt,
            durationMs: draft.durationMilliseconds,
            language: draft.language.rawValue,
            captureMode: draft.mode.rawValue,
            audioRetention: draft.mode.audioRetention
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let metadataJson = String(decoding: try encoder.encode(metadata), as: UTF8.self)
        return VoiceCaptureDocument(path: path, content: content, metadataJson: metadataJson)
    }

    static func defaultTitle(capturedAt: Date) -> String {
        "Voice note — \(makeTitleTimestampFormatter().string(from: capturedAt))"
    }

    private static func durationLabel(milliseconds: Int64) -> String {
        let seconds = max(0, milliseconds / 1_000)
        return String(format: "%02lld:%02lld", seconds / 60, seconds % 60)
    }

    private static func makeFilenameTimestampFormatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return formatter
    }

    private static func makeTitleTimestampFormatter() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }
}

enum VoiceCaptureDocumentError: Error, LocalizedError, Equatable {
    case emptyTitle
    case emptyTranscript

    var errorDescription: String? {
        switch self {
        case .emptyTitle:
            "Voice note title is required."
        case .emptyTranscript:
            "Voice note transcript is required."
        }
    }
}

private struct VoiceCaptureMetadata: Encodable {
    let kind: String
    let version: Int
    let voiceNoteId: String
    let capturedAt: String
    let durationMs: Int64
    let language: String
    let captureMode: String
    let audioRetention: String

    enum CodingKeys: String, CodingKey {
        case kind
        case version
        case voiceNoteId = "voice_note_id"
        case capturedAt = "captured_at"
        case durationMs = "duration_ms"
        case language
        case captureMode = "capture_mode"
        case audioRetention = "audio_retention"
    }
}
