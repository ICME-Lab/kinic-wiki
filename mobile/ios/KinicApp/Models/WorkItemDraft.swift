import Foundation

/// A draft is never a shared mutation. Keep its original version for conflict detection.
struct WorkItemDraft: Codable, Equatable, Sendable {
    var captureId = UUID().uuidString.lowercased()
    var title = ""
    var body = ""
    var comment = ""
    var isEditing = false
    var base: WorkItemDetail?
}

struct WorkItemDraftScope: Equatable, Sendable {
    let principal: String
    let databaseId: String
    let key: String
}

protocol WorkItemDraftStoring: Sendable {
    func draft(in scope: WorkItemDraftScope) throws -> WorkItemDraft?
    func saveDraft(_ draft: WorkItemDraft, in scope: WorkItemDraftScope) throws
    func deleteDraft(in scope: WorkItemDraftScope) throws
}
