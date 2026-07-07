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

    func createDatabase(name: String, session: ICAuthSession) async throws -> CreatedDatabase {
        try await vfsClient.createDatabase(name: name, session: session)
    }

    func saveSourceCaptureRequest(_ request: SourceCaptureRequest, session: ICAuthSession) async throws -> CaptureSubmission {
        try await vfsClient.saveSourceCaptureRequest(request, session: session)
    }

    func triggerSourceCapture(databaseId: String, requestPath: String, session: ICAuthSession) async throws {
        try await vfsClient.triggerSourceCapture(databaseId: databaseId, requestPath: requestPath, session: session)
    }
}
