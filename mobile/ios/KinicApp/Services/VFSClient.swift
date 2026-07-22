// Where: mobile/ios/KinicApp/Services/VFSClient.swift
// What: Typed VFS operations used by native source capture.
// Why: KinicICClient should coordinate the workflow without exposing raw Candid bytes.

import Foundation
import ICNativeClient

struct VFSClient: @unchecked Sendable {
    private let client: ICClient
    private let configuration: AppConfiguration
    private let urlSession: URLSession

    init(client: ICClient, configuration: AppConfiguration, urlSession: URLSession = .shared) {
        self.client = client
        self.configuration = configuration
        self.urlSession = urlSession
    }

    func listWritableDatabases(session: ICAuthSession) async throws -> [DatabaseSummary] {
        try await listReadableDatabases(session: session).filter(\.canWrite)
    }

    func listReadableDatabases(session: ICAuthSession) async throws -> [DatabaseSummary] {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "list_databases",
            arg: VFSCandidEncoder.empty(),
            identity: session
        )
        return try VFSCandidDecoder.decodeDatabaseSummaries(data)
            .filter(\.canRead)
            .sorted { left, right in
                left.displayTitle.localizedCaseInsensitiveCompare(right.displayTitle) == .orderedAscending
            }
    }

    func listPublicDatabases() async throws -> [DatabaseSummary] {
        let data = try await client.queryRaw(
            method: "list_databases",
            arg: VFSCandidEncoder.empty(),
            identity: nil
        )
        return try VFSCandidDecoder.decodeDatabaseSummaries(data)
            .filter(\.canRead)
            .sorted { left, right in
                left.displayTitle.localizedCaseInsensitiveCompare(right.displayTitle) == .orderedAscending
            }
    }

    func marketListEntitlements(session: ICAuthSession, cursor: String?, limit: UInt32) async throws -> MarketEntitlementPage {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "market_list_entitlements",
            arg: VFSCandidEncoder.marketListEntitlements(cursor: cursor, limit: limit),
            identity: session
        )
        return try VFSCandidDecoder.decodeMarketEntitlementPageResult(data)
    }

    func getCyclesBillingConfig(session: ICAuthSession) async throws -> CyclesBillingConfig {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "get_cycles_billing_config",
            arg: VFSCandidEncoder.empty(),
            identity: session
        )
        return try VFSCandidDecoder.decodeCyclesBillingConfigResult(data)
    }

    func readNode(databaseId: String, path: String, session: ICAuthSession) async throws -> VFSNode? {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "read_node",
            arg: VFSCandidEncoder.readNode(databaseId: databaseId, path: path),
            identity: session
        )
        return try VFSCandidDecoder.decodeReadNodeResult(data)
    }

    func writeNode(
        databaseId: String,
        path: String,
        kind: VFSNodeKind,
        content: String,
        metadataJson: String,
        expectedEtag: String?,
        session: ICAuthSession
    ) async throws {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.callRaw(
            method: "write_node",
            arg: VFSCandidEncoder.writeNode(
                databaseId: databaseId,
                path: path,
                kind: kind,
                content: content,
                metadataJson: metadataJson,
                expectedEtag: expectedEtag
            ),
            identity: session
        )
        try VFSCandidDecoder.decodeWriteNodeResult(data)
    }

    func readBrowseNode(databaseId: String, path: String, session: ICAuthSession?) async throws -> VFSNode? {
        if let session {
            try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        }
        let data = try await client.queryRaw(
            method: "read_node",
            arg: VFSCandidEncoder.readNode(databaseId: databaseId, path: path),
            identity: session
        )
        return try VFSCandidDecoder.decodeReadNodeResult(data)
    }

    func listBrowseChildren(databaseId: String, path: String, session: ICAuthSession?) async throws -> [ChildNode] {
        if let session {
            try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        }
        let data = try await client.queryRaw(
            method: "list_children",
            arg: VFSCandidEncoder.listChildren(databaseId: databaseId, path: path),
            identity: session
        )
        return try VFSCandidDecoder.decodeChildNodesResult(data)
            .sorted(by: childSort)
    }

    func searchBrowseNodes(databaseId: String, query: String, prefix: String?, limit: UInt32, session: ICAuthSession?) async throws -> [SearchNodeHit] {
        if let session {
            try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        }
        let data = try await client.queryRaw(
            method: "search_nodes",
            arg: VFSCandidEncoder.searchNodes(databaseId: databaseId, query: query, prefix: prefix, topK: limit),
            identity: session
        )
        return try VFSCandidDecoder.decodeSearchNodeHitsResult(data)
    }

    func createDatabase(name: String, session: ICAuthSession) async throws -> CreatedDatabase {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.callRaw(
            method: "create_database",
            arg: VFSCandidEncoder.createDatabase(name: name),
            identity: session
        )
        return try VFSCandidDecoder.decodeCreateDatabaseResult(data)
    }

    func updateDatabaseMetadata(databaseId: String, name: String, description: String, llmSummary: String?, tagsJson: String, session: ICAuthSession) async throws -> DatabaseMetadata {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.callRaw(
            method: "update_database_metadata",
            arg: VFSCandidEncoder.updateDatabaseMetadata(
                databaseId: databaseId,
                name: name,
                description: description,
                llmSummary: llmSummary,
                tagsJson: tagsJson
            ),
            identity: session
        )
        return try VFSCandidDecoder.decodeDatabaseMetadataResult(data)
    }

    func listDatabaseMembers(databaseId: String, session: ICAuthSession) async throws -> [DatabaseMember] {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "list_database_members",
            arg: VFSCandidEncoder.textArgsForDatabase(databaseId),
            identity: session
        )
        return try VFSCandidDecoder.decodeDatabaseMembersResult(data)
            .sorted { left, right in
                if left.role != right.role {
                    return left.role.sortRank < right.role.sortRank
                }
                return left.principal.localizedCaseInsensitiveCompare(right.principal) == .orderedAscending
            }
    }

    func grantDatabaseAccess(databaseId: String, principal: String, role: DatabaseRole, session: ICAuthSession) async throws {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.callRaw(
            method: "grant_database_access",
            arg: VFSCandidEncoder.grantDatabaseAccess(databaseId: databaseId, principal: principal, role: role),
            identity: session
        )
        try VFSCandidDecoder.decodeUnitResult(data)
    }

    func revokeDatabaseAccess(databaseId: String, principal: String, session: ICAuthSession) async throws {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.callRaw(
            method: "revoke_database_access",
            arg: VFSCandidEncoder.revokeDatabaseAccess(databaseId: databaseId, principal: principal),
            identity: session
        )
        try VFSCandidDecoder.decodeUnitResult(data)
    }

    func listDatabaseCycleEntries(databaseId: String, cursor: UInt64?, limit: UInt32, session: ICAuthSession) async throws -> DatabaseCycleEntryPage {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "list_database_cycle_entries",
            arg: VFSCandidEncoder.listDatabaseCycleEntries(databaseId: databaseId, cursor: cursor, limit: limit),
            identity: session
        )
        return try VFSCandidDecoder.decodeDatabaseCycleEntryPageResult(data)
    }

    func listDatabaseCyclesPendingPurchases(databaseId: String, session: ICAuthSession) async throws -> [DatabaseCyclesPendingPurchase] {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "list_database_cycles_pending_purchases",
            arg: VFSCandidEncoder.textArgsForDatabase(databaseId),
            identity: session
        )
        return try VFSCandidDecoder.decodeDatabaseCyclesPendingPurchasesResult(data)
    }

    func deleteDatabase(databaseId: String, session: ICAuthSession) async throws {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.callRaw(
            method: "delete_database",
            arg: VFSCandidEncoder.deleteDatabase(databaseId: databaseId),
            identity: session
        )
        try VFSCandidDecoder.decodeUnitResult(data)
    }

    func saveSourceCaptureRequest(_ request: SourceCaptureRequest, session: ICAuthSession) async throws -> CaptureSubmission {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let sessionNonce = UUID().uuidString.lowercased()
        if let existing = try await readNode(databaseId: request.databaseId, path: request.requestPath, session: session) {
            guard isSameSourceCaptureRequest(existing, request) else {
                throw VFSClientError.conflictingSourceCaptureRequest(request.requestPath)
            }
        } else {
            let writeData = try await client.callRaw(
                method: "write_nodes",
                arg: VFSCandidEncoder.writeNodes(request),
                identity: session
            )
            try VFSCandidDecoder.decodeWriteNodesResult(writeData)
        }
        return CaptureSubmission(
            databaseId: request.databaseId,
            requestPath: request.requestPath,
            requestId: request.requestId,
            url: request.normalizedURL,
            sessionNonce: sessionNonce
        )
    }

    func triggerSourceCapture(databaseId: String, requestPath: String, sessionNonce: String, session: ICAuthSession) async throws {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let authorizeData = try await client.callRaw(
            method: "authorize_source_capture_trigger_session",
            arg: VFSCandidEncoder.authorizeSourceCaptureTriggerSession(
                databaseId: databaseId,
                sessionNonce: sessionNonce
            ),
            identity: session
        )
        try VFSCandidDecoder.decodeUnitResult(authorizeData)
        let trigger = await triggerWorker(
            databaseId: databaseId,
            requestPath: requestPath,
            sessionNonce: sessionNonce
        )
        guard trigger.accepted else {
            throw VFSClientError.workerTriggerFailed(trigger.error ?? "worker trigger failed")
        }
    }

}

private func childSort(_ left: ChildNode, _ right: ChildNode) -> Bool {
    if left.kind == .folder && right.kind != .folder {
        return true
    }
    if left.kind != .folder && right.kind == .folder {
        return false
    }
    return left.name.localizedCaseInsensitiveCompare(right.name) == .orderedAscending
}

func isSameSourceCaptureRequest(_ existing: VFSNode, _ request: SourceCaptureRequest) -> Bool {
    guard existing.path == request.requestPath, existing.kind == .file else {
        return false
    }
    if existing.content == request.content, existing.metadataJson == request.metadataJson {
        return true
    }
    guard request.outputLanguage == .english,
          let legacyContent = legacyEnglishSourceCaptureContent(request.content),
          let legacyMetadataJson = legacyEnglishSourceCaptureMetadata(request.metadataJson) else {
        return false
    }
    return existing.content == legacyContent && existing.metadataJson == legacyMetadataJson
}

private func legacyEnglishSourceCaptureContent(_ content: String) -> String? {
    let field = "\noutput_language: \"en\"\n"
    guard let range = content.range(of: field) else {
        return nil
    }
    var legacy = content
    legacy.replaceSubrange(range, with: "\n")
    return legacy
}

private func legacyEnglishSourceCaptureMetadata(_ metadataJson: String) -> String? {
    guard let data = metadataJson.data(using: .utf8),
          var metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          metadata["output_language"] as? String == WikiOutputLanguage.english.rawValue else {
        return nil
    }
    metadata.removeValue(forKey: "output_language")
    guard let legacyData = try? JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]) else {
        return nil
    }
    return String(data: legacyData, encoding: .utf8)
}

private extension VFSClient {
    private func triggerWorker(databaseId: String, requestPath: String, sessionNonce: String) async -> TriggerResult {
        do {
            var request = URLRequest(url: configuration.sourceCaptureTriggerURL)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.setValue(configuration.authOrigin.absoluteString.trimmedTrailingSlash, forHTTPHeaderField: "Origin")
            request.httpBody = try JSONEncoder().encode(
                TriggerRequest(
                    canisterId: configuration.canisterId,
                    databaseId: databaseId,
                    requestPath: requestPath,
                    sessionNonce: sessionNonce
                )
            )
            let (data, response) = try await urlSession.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                return TriggerResult(accepted: false, error: "worker trigger failed")
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let message = String(data: data, encoding: .utf8) ?? "HTTP \(httpResponse.statusCode)"
                return TriggerResult(accepted: false, error: "worker trigger failed: \(message)")
            }
            return TriggerResult(accepted: true, error: nil)
        } catch {
            return TriggerResult(accepted: false, error: error.localizedDescription)
        }
    }
}

private enum VFSClientError: Error, LocalizedError, Equatable {
    case conflictingSourceCaptureRequest(String)
    case workerTriggerFailed(String)

    var errorDescription: String? {
        switch self {
        case .conflictingSourceCaptureRequest(let path):
            "Source capture request already exists with different content: \(path)"
        case .workerTriggerFailed(let message):
            message
        }
    }
}

private struct TriggerRequest: Encodable {
    let canisterId: String
    let databaseId: String
    let requestPath: String
    let sessionNonce: String
}

private struct TriggerResult {
    let accepted: Bool
    let error: String?
}

private extension String {
    var trimmedTrailingSlash: String {
        trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}
