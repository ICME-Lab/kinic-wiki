// Where: mobile/ios/KinicApp/Models/WorkItem.swift
// What: Domain model for one DB-scoped shared work item.
// Why: The Markdown body and its versioned metadata form one unit that must round-trip without guessing.

import Foundation

enum WorkItemState: String, Codable, Equatable, Sendable {
    case open
    case closed

    var displayName: String {
        switch self {
        case .open: "Open"
        case .closed: "Closed"
        }
    }
}

enum WorkItemSourceKind: String, Codable, Equatable, Sendable {
    case text
    case voice
    case share
    case wiki
    case askAI = "ask_ai"
}

struct WorkItemSource: Codable, Equatable, Sendable {
    var kind: WorkItemSourceKind
    var url: String?
    var path: String?
    var label: String?
}

/// One work item as stored at `/WorkItems/<id>/item.md`.
struct WorkItem: Identifiable, Equatable, Sendable {
    let id: String
    let captureId: String
    var title: String
    var state: WorkItemState
    var body: String
    var createdBy: String
    var createdAt: Int64
    var updatedAt: Int64
    var etag: String
    var source: WorkItemSource?
}

/// One row of the Home list. Built from `meta.md` and rebuilt from `item.md` when that cache is missing.
struct WorkItemListEntry: Identifiable, Equatable, Sendable {
    let id: String
    var title: String
    var state: WorkItemState
    var commentCount: Int
    var updatedAt: Int64
    /// True when `item.md` declares a document version this build does not understand.
    var isUnsupportedVersion: Bool

    var sortKey: Int64 { updatedAt }
}

struct WorkItemListSnapshot: Equatable, Sendable {
    var entries: [WorkItemListEntry]
    /// Item directories found in the database, whether or not their metadata was read.
    var totalCount: Int
    /// True when more readable items exist than the UI's display limit.
    var isTruncated: Bool
    /// Item directories whose metadata could not be read at all.
    var unreadableCount: Int
}

/// A work item plus the etags needed to write it back without overwriting another member.
struct WorkItemDetail: Equatable, Sendable {
    var item: WorkItem
    var itemEtag: String
    /// `nil` when the derived list document is missing and could not be rebuilt.
    var listEtag: String?
    var commentCount: Int
    /// Set when `item.md` declares a document version this build does not understand.
    var unsupportedVersion: Int?

    var isUnsupportedVersion: Bool { unsupportedVersion != nil }
}

/// Local-only capture record. Survives app termination and offline periods.
struct WorkItemCaptureRecord: Identifiable, Equatable, Sendable {
    let captureId: String
    var principal: String
    /// Frozen at capture time. Switching databases must not retarget an unsent capture.
    var databaseId: String?
    var origin: WorkItemSourceKind
    var rawText: String
    var provisionalTitle: String
    var transcript: String?
    var audioRelativePath: String?
    var audioDurationMs: Int64?
    var sourceRefs: [WorkItemSource]
    var state: WorkItemCaptureState
    var baseEtag: String?
    var aiSuggestionJson: String?
    var createdAt: Int64
    var updatedAt: Int64
    var sentAt: Int64?

    var id: String { captureId }
}

enum WorkItemCaptureState: String, Equatable, Sendable {
    /// Saved on this device only. Never presented as shared.
    case local
    /// Committed to the database.
    case sent
    case aiRunning = "ai_running"
    case aiApplied = "ai_applied"
    case aiFailed = "ai_failed"
    /// A human edited the body after the capture, so the AI result stays a suggestion.
    case rebaseRequired = "rebase_required"

    var displayName: String {
        switch self {
        case .local: "On this device"
        case .sent: "In database"
        case .aiRunning: "Tidying up"
        case .aiApplied: "In database"
        case .aiFailed: "In database"
        case .rebaseRequired: "In database"
        }
    }
}

/// One list-cache row, written after every successful list or change.
struct WorkItemListCacheRecord: Identifiable, Equatable, Sendable {
    let itemId: String
    var title: String
    var state: WorkItemState
    var commentCount: Int
    var updatedAt: Int64

    var id: String { itemId }
}

/// One comment document under `/WorkItems/<id>/comments/`. Append-only in the initial version.
struct WorkItemComment: Identifiable, Equatable, Sendable {
    let id: String
    let itemId: String
    var body: String
    var author: String
    var createdAt: Int64
}

struct WorkItemCommentDraft: Equatable, Sendable {
    /// Client-generated UUID. Also the comment document name, so a retry reuses the same path.
    let id: String
    var body: String
    var author: String
    var createdAt: Int64
}

/// A search hit grouped by work item. Comment matches are folded into their parent item.
struct WorkItemSearchResult: Identifiable, Equatable, Sendable {
    let id: String
    var title: String
    var state: WorkItemState?
    var snippet: String?
    var matchedCommentCount: Int
    var isUnsupportedVersion: Bool
}

struct WorkItemSearchSnapshot: Equatable, Sendable {
    var results: [WorkItemSearchResult]
    /// Raw hits returned by the canister before grouping.
    var hitCount: Int
    /// True when the canister returned its maximum number of hits, so older matches may be missing.
    var isCapped: Bool
}

/// Input kept on this device because the database did not confirm it. Replayed only by hand.
struct WorkItemPendingMutation: Identifiable, Equatable, Sendable {
    enum Kind: String, Codable, Equatable, Sendable {
        case edit
        case comment
        case close
        case reopen

        var displayName: String {
            switch self {
            case .edit: "Edit"
            case .comment: "Comment"
            case .close: "Close"
            case .reopen: "Reopen"
            }
        }
    }

    struct EditPayload: Codable, Equatable, Sendable {
        var title: String
        var body: String
        var baseEtag: String
        var listEtag: String?
        var commentCount: Int
    }

    struct CommentPayload: Codable, Equatable, Sendable {
        var body: String
        var author: String
    }

    struct StatePayload: Codable, Equatable, Sendable {
        var baseEtag: String
    }

    let mutationId: String
    let kind: Kind
    let itemId: String
    let createdAt: Int64
    /// `EditPayload` for `.edit`, `CommentPayload` for `.comment`, `{}` otherwise.
    let payloadJson: String

    var id: String { mutationId }

    var editPayload: EditPayload? {
        try? JSONDecoder().decode(EditPayload.self, from: Data(payloadJson.utf8))
    }

    var commentPayload: CommentPayload? {
        try? JSONDecoder().decode(CommentPayload.self, from: Data(payloadJson.utf8))
    }

    var statePayload: StatePayload? {
        try? JSONDecoder().decode(StatePayload.self, from: Data(payloadJson.utf8))
    }

    static func encoded<T: Encodable>(_ payload: T) -> String {
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return json
    }
}

/// A save the database rejected because another member wrote first. Never applied silently.
struct WorkItemConflict: Equatable, Sendable {
    var itemId: String
    var mine: WorkItem
    var latest: WorkItemDetail
}

/// A request to open one work item's detail from another surface, such as Browse.
struct WorkItemDetailRequest: Equatable, Sendable {
    let databaseId: String
    let itemId: String
}
