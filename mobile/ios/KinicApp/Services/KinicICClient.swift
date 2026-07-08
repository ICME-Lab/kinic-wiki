// Where: mobile/ios/KinicApp/Services/KinicICClient.swift
// What: Native IC client boundary for VFS source capture requests.
// Why: ICNativeClient owns transport and delegation validation; VFS Candid remains explicit.

import Foundation
import ICNativeClient

actor KinicICClient {
    private let client: ICClient
    private let configuration: AppConfiguration
    private let vfsClient: VFSClient

    init(configuration: AppConfiguration) {
        self.configuration = configuration
        client = ICClient(configuration: configuration.icClientConfiguration)
        vfsClient = VFSClient(client: client, configuration: configuration)
    }

    func listWritableDatabases(session: ICAuthSession) async throws -> [DatabaseSummary] {
        try await vfsClient.listWritableDatabases(session: session)
    }

    func listReadableDatabases(session: ICAuthSession) async throws -> [DatabaseSummary] {
        try await vfsClient.listReadableDatabases(session: session)
    }

    func getCyclesBillingConfig(session: ICAuthSession) async throws -> CyclesBillingConfig {
        try await vfsClient.getCyclesBillingConfig(session: session)
    }

    func readNode(databaseId: String, path: String, session: ICAuthSession) async throws -> VFSNode? {
        try await vfsClient.readNode(databaseId: databaseId, path: path, session: session)
    }

    func listChildren(databaseId: String, path: String, session: ICAuthSession) async throws -> [ChildNode] {
        try await vfsClient.listChildren(databaseId: databaseId, path: path, session: session)
    }

    func searchNodes(databaseId: String, query: String, prefix: String?, limit: UInt32, session: ICAuthSession) async throws -> [SearchNodeHit] {
        try await vfsClient.searchNodes(databaseId: databaseId, query: query, prefix: prefix, limit: limit, session: session)
    }

    func createDatabase(name: String, session: ICAuthSession) async throws -> CreatedDatabase {
        try await vfsClient.createDatabase(name: name, session: session)
    }

    func updateDatabaseMetadata(databaseId: String, name: String, description: String, llmSummary: String?, tagsJson: String, session: ICAuthSession) async throws -> DatabaseMetadata {
        try await vfsClient.updateDatabaseMetadata(
            databaseId: databaseId,
            name: name,
            description: description,
            llmSummary: llmSummary,
            tagsJson: tagsJson,
            session: session
        )
    }

    func listDatabaseMembers(databaseId: String, session: ICAuthSession) async throws -> [DatabaseMember] {
        try await vfsClient.listDatabaseMembers(databaseId: databaseId, session: session)
    }

    func grantDatabaseAccess(databaseId: String, principal: String, role: DatabaseRole, session: ICAuthSession) async throws {
        try await vfsClient.grantDatabaseAccess(databaseId: databaseId, principal: principal, role: role, session: session)
    }

    func revokeDatabaseAccess(databaseId: String, principal: String, session: ICAuthSession) async throws {
        try await vfsClient.revokeDatabaseAccess(databaseId: databaseId, principal: principal, session: session)
    }

    func listDatabaseCycleEntries(databaseId: String, cursor: UInt64?, limit: UInt32, session: ICAuthSession) async throws -> DatabaseCycleEntryPage {
        try await vfsClient.listDatabaseCycleEntries(databaseId: databaseId, cursor: cursor, limit: limit, session: session)
    }

    func listDatabaseCyclesPendingPurchases(databaseId: String, session: ICAuthSession) async throws -> [DatabaseCyclesPendingPurchase] {
        try await vfsClient.listDatabaseCyclesPendingPurchases(databaseId: databaseId, session: session)
    }

    func deleteDatabase(databaseId: String, session: ICAuthSession) async throws {
        try await vfsClient.deleteDatabase(databaseId: databaseId, session: session)
    }

    func saveSourceCaptureRequest(_ request: SourceCaptureRequest, session: ICAuthSession) async throws -> CaptureSubmission {
        try await vfsClient.saveSourceCaptureRequest(request, session: session)
    }

    func triggerSourceCapture(databaseId: String, requestPath: String, sessionNonce: String, session: ICAuthSession) async throws {
        try await vfsClient.triggerSourceCapture(databaseId: databaseId, requestPath: requestPath, sessionNonce: sessionNonce, session: session)
    }
}
