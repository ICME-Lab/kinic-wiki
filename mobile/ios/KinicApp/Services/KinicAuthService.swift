// Where: mobile/ios/KinicApp/Services/KinicAuthService.swift
// What: Internet Identity login and Keychain session storage.
// Why: App and future canister writes need the same native delegation session.

import Foundation
import ICNativeClient

@MainActor
final class KinicAuthService {
    private let authenticateSession: (Bool) async throws -> KinicIdentitySession
    private let restoreSession: () throws -> KinicIdentitySession?
    private let saveSession: (KinicIdentitySession) throws -> Void
    private let clearSession: () throws -> Void
    private let prefersEphemeralWebBrowserSession: Bool

    init(
        configuration: AppConfiguration,
        prefersEphemeralWebBrowserSession: Bool? = nil
    ) throws {
        let authenticator = try ICInternetIdentityAuthenticator(
            configuration: configuration.makeICClientConfiguration(),
            callbackURL: configuration.makeAuthenticationCallbackURL()
        )
        let store = try KinicAuthSessionStore(configuration: configuration)
        authenticateSession = { prefersEphemeralWebBrowserSession in
            let session = try await authenticator.authenticate(
                prefersEphemeralWebBrowserSession: prefersEphemeralWebBrowserSession
            )
            return KinicIdentitySession(nativeSession: session)
        }
        restoreSession = { try store.restore() }
        saveSession = { try store.save($0) }
        clearSession = { try store.clear() }
        self.prefersEphemeralWebBrowserSession =
            prefersEphemeralWebBrowserSession
            ?? Self.debugPrefersEphemeralWebBrowserSession(environment: ProcessInfo.processInfo.environment)
    }

    init(
        prefersEphemeralWebBrowserSession: Bool = false,
        authenticateSession: @escaping (Bool) async throws -> KinicIdentitySession,
        restoreSession: @escaping () throws -> KinicIdentitySession? = { nil },
        saveSession: @escaping (KinicIdentitySession) throws -> Void,
        clearSession: @escaping () throws -> Void = {}
    ) {
        self.authenticateSession = authenticateSession
        self.restoreSession = restoreSession
        self.saveSession = saveSession
        self.clearSession = clearSession
        self.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
    }

    func restore() throws -> KinicIdentitySession? {
        try restoreSession()
    }

    func signIn(
        verify: (KinicIdentitySession) async throws -> Void
    ) async throws -> KinicIdentitySession {
        let session = try await authenticateSession(prefersEphemeralWebBrowserSession)
        try await verify(session)
        try saveSession(session)
        return session
    }

    func signOut() throws {
        try clearSession()
    }

    nonisolated static func debugPrefersEphemeralWebBrowserSession(
        environment: [String: String]
    ) -> Bool {
#if DEBUG
        environment["KINIC_EPHEMERAL_AUTH"] == "1"
#else
        false
#endif
    }
}
