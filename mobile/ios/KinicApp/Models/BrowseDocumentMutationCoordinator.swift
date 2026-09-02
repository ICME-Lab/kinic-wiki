// Where: mobile/ios/KinicApp/Models/BrowseDocumentMutationCoordinator.swift
// What: Tracks ownership of one in-flight browse document mutation.
// Why: A stale completion must not clear or overwrite a newer document operation.

import Foundation

struct BrowseDocumentMutationCoordinator: Equatable, Sendable {
    struct Context: Equatable, Sendable {
        let id: UUID
        let mutation: BrowseDocumentMutation
        let databaseId: String
        let path: String
    }

    private(set) var activeContext: Context?

    var mutation: BrowseDocumentMutation? {
        activeContext?.mutation
    }

    mutating func begin(
        mutation: BrowseDocumentMutation,
        databaseId: String,
        path: String
    ) -> Context? {
        guard activeContext == nil else { return nil }
        let context = Context(
            id: UUID(),
            mutation: mutation,
            databaseId: databaseId,
            path: path
        )
        activeContext = context
        return context
    }

    func owns(_ context: Context) -> Bool {
        activeContext?.id == context.id
    }

    mutating func finish(_ context: Context) {
        guard owns(context) else { return }
        activeContext = nil
    }

    mutating func invalidate() {
        activeContext = nil
    }
}
