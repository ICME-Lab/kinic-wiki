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

    func listWritableDatabases(session: KinicIdentitySession) async throws -> [DatabaseSummary] {
        try await listReadableDatabases(session: session).filter(\.canWrite)
    }

    func listReadableDatabases(session: KinicIdentitySession) async throws -> [DatabaseSummary] {
        let result: VFSCandidResult<[DatabaseSummary], String> = try await client.query(
            method: "list_databases", identity: try nativeIdentity(session)
        )
        return try result.textValue()
            .filter(\.canRead)
            .sorted { left, right in
                left.displayTitle.localizedCaseInsensitiveCompare(right.displayTitle) == .orderedAscending
            }
    }

    func listPublicDatabases() async throws -> [DatabaseSummary] {
        let result: VFSCandidResult<[DatabaseSummary], String> = try await client.query(method: "list_databases")
        return try result.textValue()
            .filter(\.canRead)
            .sorted { left, right in
                left.displayTitle.localizedCaseInsensitiveCompare(right.displayTitle) == .orderedAscending
            }
    }

    func marketListEntitlements(session: KinicIdentitySession, cursor: String?, limit: UInt32) async throws -> MarketEntitlementPage {
        let result: VFSCandidResult<MarketEntitlementPage, String> = try await client.query(
            method: "market_list_entitlements",
            arguments: try arguments(cursor, limit),
            identity: try nativeIdentity(session)
        )
        return try result.textValue()
    }

    func getCyclesBillingConfig(session: KinicIdentitySession) async throws -> CyclesBillingConfig {
        let result: VFSCandidResult<CyclesBillingConfig, String> = try await client.query(method: "get_cycles_billing_config", identity: try nativeIdentity(session))
        return try result.textValue()
    }

    func readNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> VFSNode? {
        let result: VFSCandidResult<VFSNode?, String> = try await client.query(
            method: "read_node",
            arguments: try arguments(databaseId, path),
            identity: try nativeIdentity(session)
        )
        return try result.textValue()
    }

    func sourceURLExists(databaseId: String, url: URL, session: KinicIdentitySession) async throws -> Bool {
        let lookupURLs = try Self.sourceLookupURLs(for: url)
        let result: VFSCandidResult<VFSSQLJSONResult, String> = try await client.query(
            method: "query_database_sql_json",
            arguments: try arguments(databaseId, Self.sourceURLExistsSQL(normalizedURLs: lookupURLs), UInt32(1)),
            identity: try nativeIdentity(session)
        )
        return try !result.textValue().rows.isEmpty
    }

    static func sourceLookupURLs(for url: URL) throws -> [String] {
        let normalizedURL = try URLNormalizer.normalizedHTTPURL(url)
        var candidates = [normalizedURL.absoluteString]
        guard var components = URLComponents(url: normalizedURL, resolvingAgainstBaseURL: false) else {
            return candidates
        }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        if (components.scheme == "http" && components.port == 80)
            || (components.scheme == "https" && components.port == 443) {
            components.port = nil
        }
        if components.percentEncodedPath.isEmpty {
            components.percentEncodedPath = "/"
        }
        if let workerNormalizedURL = components.url?.absoluteString,
           !candidates.contains(workerNormalizedURL) {
            candidates.append(workerNormalizedURL)
        }
        return candidates
    }

    static func sourceURLExistsSQL(normalizedURLs: [String]) -> String {
        let urlConditions = normalizedURLs.map { normalizedURL in
            let escapedURL = normalizedURL.replacingOccurrences(of: "'", with: "''")
            return """
            (json_extract(metadata_json, '$.url') = '\(escapedURL)'
             OR json_extract(metadata_json, '$.final_url') = '\(escapedURL)')
            """
        }.joined(separator: "\n            OR ")
        return """
        SELECT json_object('path', path)
        FROM fs_nodes
        WHERE kind = 'source'
          AND path >= '/Sources/web/'
          AND path < '/Sources/web0'
          AND json_valid(metadata_json)
          AND (
            \(urlConditions)
          )
        LIMIT 1
        """
    }

    @discardableResult
    func writeNode(
        databaseId: String,
        path: String,
        kind: VFSNodeKind,
        content: String,
        metadataJson: String,
        expectedEtag: String?,
        session: KinicIdentitySession
    ) async throws -> VFSWriteNodeResult {
        let result: VFSCandidResult<VFSWriteNodeResult, VFSNodeMutationFailure> = try await client.call(
            method: "write_node",
            argument: VFSWriteNodeRequest(
                databaseId: databaseId,
                path: path,
                kind: kind,
                content: content,
                metadataJson: metadataJson,
                expectedEtag: expectedEtag
            ), identity: try nativeIdentity(session)
        )
        return try result.mutationValue()
    }

    func readBrowseNode(databaseId: String, path: String, session: KinicIdentitySession?) async throws -> VFSNode? {
        let result: VFSCandidResult<VFSNode?, String> = try await client.query(
            method: "read_node",
            arguments: try arguments(databaseId, path),
            identity: try session.map(nativeIdentity)
        )
        return try result.textValue()
    }

    func getNodePublication(databaseId: String, path: String, session: KinicIdentitySession) async throws -> NodePublication? {
        let result: VFSCandidResult<NodePublication?, String> = try await client.query(method: "get_node_publication", argument: VFSPathRequest(databaseId: databaseId, path: path), identity: try nativeIdentity(session))
        return try result.textValue()
    }

    func publishNode(databaseId: String, path: String, session: KinicIdentitySession) async throws -> NodePublication {
        let result: VFSCandidResult<NodePublication, String> = try await client.call(method: "publish_node", argument: VFSPathRequest(databaseId: databaseId, path: path), identity: try nativeIdentity(session))
        return try result.textValue()
    }

    func unpublishNode(databaseId: String, path: String, session: KinicIdentitySession) async throws {
        let result: VFSCandidResult<CandidNull, String> = try await client.call(method: "unpublish_node", argument: VFSPathRequest(databaseId: databaseId, path: path), identity: try nativeIdentity(session))
        _ = try result.textValue()
    }

    func deleteNode(databaseId: String, path: String, expectedEtag: String, session: KinicIdentitySession) async throws {
        let result: VFSCandidResult<VFSDeleteNodeResult, VFSNodeMutationFailure> = try await client.call(
            method: "delete_node",
            argument: VFSDeleteNodeRequest(databaseId: databaseId, path: path, expectedEtag: expectedEtag),
            identity: try nativeIdentity(session)
        )
        let deletedPath = try result.mutationValue().path
        guard deletedPath == path else {
            throw VFSClientError.unexpectedDeletedPath(expected: path, actual: deletedPath)
        }
    }

    func listBrowseChildren(databaseId: String, path: String, session: KinicIdentitySession?) async throws -> [ChildNode] {
        let result: VFSCandidResult<[ChildNode], String> = try await client.query(
            method: "list_children",
            argument: VFSPathRequest(databaseId: databaseId, path: path),
            identity: try session.map(nativeIdentity)
        )
        return try result.textValue().sorted(by: childSort)
    }

    func searchBrowseNodes(databaseId: String, query: String, prefix: String?, limit: UInt32, session: KinicIdentitySession?) async throws -> [SearchNodeHit] {
        let result: VFSCandidResult<[SearchNodeHit], String> = try await client.query(
            method: "search_nodes",
            argument: VFSSearchNodesRequest(databaseId: databaseId, queryText: query, prefix: prefix, topK: limit),
            identity: try session.map(nativeIdentity)
        )
        return try result.textValue()
    }

    func createDatabase(name: String, session: KinicIdentitySession) async throws -> CreatedDatabase {
        let result: VFSCandidResult<CreatedDatabase, String> = try await client.call(method: "create_database", argument: VFSCreateDatabaseRequest(name: name), identity: try nativeIdentity(session))
        return try result.textValue()
    }

    func updateDatabaseMetadata(databaseId: String, name: String, description: String, llmSummary: String?, tagsJson: String, session: KinicIdentitySession) async throws -> DatabaseMetadata {
        let result: VFSCandidResult<DatabaseMetadata, String> = try await client.call(
            method: "update_database_metadata",
            argument: VFSUpdateDatabaseMetadataRequest(
                databaseId: databaseId,
                name: name,
                description: description,
                llmSummary: llmSummary,
                tagsJson: tagsJson
            ), identity: try nativeIdentity(session)
        )
        return try result.textValue()
    }

    func listDatabaseMembers(databaseId: String, session: KinicIdentitySession) async throws -> [DatabaseMember] {
        let result: VFSCandidResult<[DatabaseMember], String> = try await client.query(
            method: "list_database_members",
            arguments: try arguments(databaseId),
            identity: try nativeIdentity(session)
        )
        return try result.textValue()
            .sorted { left, right in
                if left.role != right.role {
                    return left.role.sortRank < right.role.sortRank
                }
                return left.principal.localizedCaseInsensitiveCompare(right.principal) == .orderedAscending
            }
    }

    func grantDatabaseAccess(databaseId: String, principal: String, role: DatabaseRole, session: KinicIdentitySession) async throws {
        let result: VFSCandidResult<CandidNull, String> = try await client.call(
            method: "grant_database_access",
            arguments: try arguments(databaseId, principal, role),
            identity: try nativeIdentity(session)
        )
        _ = try result.textValue()
    }

    func revokeDatabaseAccess(databaseId: String, principal: String, session: KinicIdentitySession) async throws {
        let result: VFSCandidResult<CandidNull, String> = try await client.call(
            method: "revoke_database_access",
            arguments: try arguments(databaseId, principal),
            identity: try nativeIdentity(session)
        )
        _ = try result.textValue()
    }

    func listDatabaseCycleEntries(databaseId: String, cursor: UInt64?, limit: UInt32, session: KinicIdentitySession) async throws -> DatabaseCycleEntryPage {
        let result: VFSCandidResult<DatabaseCycleEntryPage, String> = try await client.query(
            method: "list_database_cycle_entries",
            arguments: try arguments(databaseId, cursor, limit),
            identity: try nativeIdentity(session)
        )
        return try result.textValue()
    }

    func listDatabaseCyclesPendingPurchases(databaseId: String, session: KinicIdentitySession) async throws -> [DatabaseCyclesPendingPurchase] {
        let result: VFSCandidResult<[DatabaseCyclesPendingPurchase], String> = try await client.query(
            method: "list_database_cycles_pending_purchases",
            arguments: try arguments(databaseId),
            identity: try nativeIdentity(session)
        )
        return try result.textValue()
    }

    func deleteDatabase(databaseId: String, session: KinicIdentitySession) async throws {
        let result: VFSCandidResult<CandidNull, String> = try await client.call(
            method: "delete_database",
            argument: VFSDatabaseIDRequest(databaseId: databaseId),
            identity: try nativeIdentity(session)
        )
        _ = try result.textValue()
    }

    func deleteAccount(session: KinicIdentitySession) async throws {
        let result: VFSCandidResult<CandidNull, String> = try await client.call(method: "delete_account", identity: try nativeIdentity(session))
        _ = try result.textValue()
    }

    func saveSourceCaptureRequest(_ request: SourceCaptureRequest, session: KinicIdentitySession) async throws -> CaptureSubmission {
        let identity = try nativeIdentity(session)
        let sessionNonce = UUID().uuidString.lowercased()
        if let existing = try await readNode(databaseId: request.databaseId, path: request.requestPath, session: session) {
            guard isSameSourceCaptureRequest(existing, request) else {
                throw VFSClientError.conflictingSourceCaptureRequest(request.requestPath)
            }
        } else {
            let item = VFSWriteNodeItem(content: request.content, kind: .file, path: request.requestPath, expectedEtag: nil, metadataJson: request.metadataJson)
            let result: VFSCandidResult<[VFSWriteNodeResult], VFSNodeMutationFailure> = try await client.call(
                method: "write_nodes",
                argument: VFSWriteNodesRequest(databaseId: request.databaseId, nodes: [item]),
                identity: identity
            )
            _ = try result.mutationValue()
        }
        return CaptureSubmission(
            databaseId: request.databaseId,
            requestPath: request.requestPath,
            requestId: request.requestId,
            url: request.normalizedURL,
            sessionNonce: sessionNonce
        )
    }

    func triggerSourceCapture(databaseId: String, requestPath: String, sessionNonce: String, session: KinicIdentitySession) async throws {
        let result: VFSCandidResult<CandidNull, String> = try await client.call(
            method: "authorize_source_capture_trigger_session",
            argument: VFSSourceCaptureTriggerSessionRequest(
                databaseId: databaseId,
                sessionNonce: sessionNonce
            ),
            identity: try nativeIdentity(session)
        )
        _ = try result.textValue()
        let trigger = await triggerWorker(
            databaseId: databaseId,
            requestPath: requestPath,
            sessionNonce: sessionNonce
        )
        guard trigger.accepted else {
            throw VFSClientError.workerTriggerFailed(trigger.error ?? "worker trigger failed")
        }
    }

    private func nativeIdentity(_ session: KinicIdentitySession) throws -> ICAuthSession {
        let identity = try session.requireNativeSession()
        try client.validateIdentity(identity, requestCanisterId: configuration.canisterId)
        return identity
    }

    private func arguments<A: CandidConvertible>(_ a: A) throws -> CandidArguments {
        CandidArguments([try CandidTypedValue(a)])
    }

    private func arguments<A: CandidConvertible, B: CandidConvertible>(_ a: A, _ b: B) throws -> CandidArguments {
        CandidArguments([try CandidTypedValue(a), try CandidTypedValue(b)])
    }

    private func arguments<A: CandidConvertible, B: CandidConvertible, C: CandidConvertible>(_ a: A, _ b: B, _ c: C) throws -> CandidArguments {
        CandidArguments([try CandidTypedValue(a), try CandidTypedValue(b), try CandidTypedValue(c)])
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
    case unexpectedDeletedPath(expected: String, actual: String)

    var errorDescription: String? {
        switch self {
        case .conflictingSourceCaptureRequest(let path):
            "Source capture request already exists with different content: \(path)"
        case .workerTriggerFailed(let message):
            message
        case let .unexpectedDeletedPath(expected, actual):
            "Deleted path mismatch: expected \(expected), received \(actual)"
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
