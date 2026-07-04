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
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let data = try await client.queryRaw(
            method: "list_databases",
            arg: VFSCandidEncoder.empty(),
            identity: session
        )
        return try VFSCandidDecoder.decodeDatabaseSummaries(data)
            .filter(\.canWrite)
            .sorted { left, right in
                left.displayTitle.localizedCaseInsensitiveCompare(right.displayTitle) == .orderedAscending
            }
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

    func saveSourceCaptureRequest(_ request: SourceCaptureRequest, session: ICAuthSession) async throws -> CaptureSubmission {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        try await ensureParentFolders(databaseId: request.databaseId, path: request.requestPath, session: session)
        try await ensureSourceCaptureRequest(request, session: session)
        return CaptureSubmission(
            databaseId: request.databaseId,
            requestPath: request.requestPath,
            requestId: request.requestId,
            url: request.normalizedURL
        )
    }

    func triggerSourceCapture(databaseId: String, requestPath: String, session: ICAuthSession) async throws {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        let sessionNonce = UUID().uuidString.lowercased()
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

    private func ensureSourceCaptureRequest(_ request: SourceCaptureRequest, session: ICAuthSession) async throws {
        let readData = try await client.queryRaw(
            method: "read_node",
            arg: VFSCandidEncoder.readNode(databaseId: request.databaseId, path: request.requestPath),
            identity: session
        )
        if let existing = try VFSCandidDecoder.decodeReadNodeResult(readData) {
            guard isSameSourceCaptureRequest(existing, request) else {
                throw VFSClientError.conflictingSourceCaptureRequest(request.requestPath)
            }
            return
        }
        let writeData = try await client.callRaw(
            method: "write_node",
            arg: VFSCandidEncoder.writeNode(request),
            identity: session
        )
        try VFSCandidDecoder.decodeWriteNodeResult(writeData)
    }

    private func isSameSourceCaptureRequest(_ node: VFSNode, _ request: SourceCaptureRequest) -> Bool {
        guard node.path == request.requestPath,
              node.kind == .file,
              node.content.contains("kind: kinic.source_capture_request") else {
            return false
        }
        guard let metadata = try? JSONDecoder().decode(
            SourceCaptureRequestMetadata.self,
            from: Data(node.metadataJson.utf8)
        ) else {
            return false
        }
        return metadata.requestType == "source_capture"
            && metadata.url == request.normalizedURL.absoluteString
    }
}

private struct SourceCaptureRequestMetadata: Decodable {
    let requestType: String
    let url: String

    enum CodingKeys: String, CodingKey {
        case requestType = "request_type"
        case url
    }
}

private extension VFSClient {
    private func ensureParentFolders(databaseId: String, path: String, session: ICAuthSession) async throws {
        let segments = path.split(separator: "/").map(String.init)
        var current = ""
        for segment in segments.dropLast() {
            current += "/\(segment)"
            let data = try await client.callRaw(
                method: "mkdir_node",
                arg: VFSCandidEncoder.mkdirNode(databaseId: databaseId, path: current),
                identity: session
            )
            try VFSCandidDecoder.decodeMkdirNodeResult(data)
        }
    }

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
            "Source capture request already exists with different content: \(path)."
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
