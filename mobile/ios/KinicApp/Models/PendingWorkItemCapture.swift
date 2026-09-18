// Where: mobile/ios/KinicApp/Models/PendingWorkItemCapture.swift
// What: One work item captured outside the app process.
// Why: The Share Extension must keep the member's input without writing the VFS contract itself.

import Foundation

struct PendingWorkItemCapture: Codable, Equatable, Sendable {
    static let currentVersion = 1
    static let titleCharacterLimit = 120

    var version: Int
    var captureId: String
    var principal: String
    /// Frozen when the member chose the destination, so a later switch cannot retarget it.
    var databaseId: String
    var title: String
    var body: String
    var source: WorkItemSource?
    var createdAt: Int64

    /// The device-local record the app stores before it sends the item.
    func captureRecord() -> WorkItemCaptureRecord {
        WorkItemCaptureRecord(
            captureId: captureId,
            principal: principal,
            databaseId: databaseId,
            origin: source?.kind ?? .share,
            rawText: body,
            provisionalTitle: title,
            transcript: nil,
            audioRelativePath: nil,
            audioDurationMs: nil,
            sourceRefs: source.map { [$0] } ?? [],
            state: .local,
            baseEtag: nil,
            aiSuggestionJson: nil,
            createdAt: createdAt,
            updatedAt: createdAt,
            sentAt: nil
        )
    }

    /// The shared link plus the optional one-line note the member added.
    static func sharedBody(url: String, note: String?) -> String {
        let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmedNote.isEmpty ? url : "\(url)\n\n\(trimmedNote)"
    }

    /// The best title the extension can derive without waiting for the article itself.
    static func derivedTitle(url: URL, metadataTitle: String?) -> String {
        let metadata = metadataTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !metadata.isEmpty {
            return String(metadata.prefix(titleCharacterLimit))
        }
        let host = url.host ?? ""
        let lastSegment = url.pathComponents.last { $0 != "/" && !$0.isEmpty } ?? ""
        let candidate = lastSegment.isEmpty ? host : "\(host) — \(lastSegment)"
        let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
        return String((trimmed.isEmpty ? url.absoluteString : trimmed).prefix(titleCharacterLimit))
    }
}
