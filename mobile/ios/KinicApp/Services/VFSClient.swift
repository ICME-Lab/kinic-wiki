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

    func submit(_ request: SourceCaptureRequest, session: ICAuthSession) async throws -> CaptureSubmission {
        try client.validateIdentity(session, requestCanisterId: configuration.canisterId)
        try await ensureParentFolders(databaseId: request.databaseId, path: request.requestPath, session: session)
        let writeData = try await client.callRaw(
            method: "write_node",
            arg: VFSCandidEncoder.writeNode(request),
            identity: session
        )
        try VFSCandidDecoder.decodeWriteNodeResult(writeData)

        let sessionNonce = UUID().uuidString.lowercased()
        let authorizeData = try await client.callRaw(
            method: "authorize_source_capture_trigger_session",
            arg: VFSCandidEncoder.authorizeSourceCaptureTriggerSession(
                databaseId: request.databaseId,
                sessionNonce: sessionNonce
            ),
            identity: session
        )
        try VFSCandidDecoder.decodeUnitResult(authorizeData)

        let trigger = await triggerWorker(
            databaseId: request.databaseId,
            requestPath: request.requestPath,
            sessionNonce: sessionNonce
        )
        return CaptureSubmission(
            requestPath: request.requestPath,
            triggered: trigger.accepted,
            triggerError: trigger.error
        )
    }

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
