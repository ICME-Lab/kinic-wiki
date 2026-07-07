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

    func listChildren(databaseId: String, path: String, session: ICAuthSession) async throws -> [ChildNode] {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "list_children",
            arg: VFSCandidEncoder.listChildren(databaseId: databaseId, path: path),
            identity: session
        )
        return try VFSCandidDecoder.decodeChildNodesResult(data)
            .sorted(by: childSort)
    }

    func searchNodes(databaseId: String, query: String, prefix: String?, limit: UInt32, session: ICAuthSession) async throws -> [SearchNodeHit] {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
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
        let authorizeData = try await client.callRaw(
            method: "authorize_source_capture_trigger_session",
            arg: VFSCandidEncoder.authorizeSourceCaptureTriggerSession(
                databaseId: request.databaseId,
                sessionNonce: sessionNonce
            ),
            identity: session
        )
        try VFSCandidDecoder.decodeUnitResult(authorizeData)
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

private func isSameSourceCaptureRequest(_ existing: VFSNode, _ request: SourceCaptureRequest) -> Bool {
    existing.path == request.requestPath
        && existing.kind == .file
        && existing.content == request.content
        && existing.metadataJson == request.metadataJson
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
