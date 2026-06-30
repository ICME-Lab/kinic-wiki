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

    func submit(_ request: SourceCaptureRequest, session: ICAuthSession) async throws -> CaptureSubmission {
        try await vfsClient.submit(request, session: session)
    }
}
