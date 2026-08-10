// Where: mobile/ios/KinicApp/Services/KinicAuthService.swift
// What: Internet Identity login and Keychain session storage.
// Why: App and future canister writes need the same native delegation session.

import Foundation
import ICNativeClient

@MainActor
final class KinicAuthService {
    private let authenticateSession: (Bool) async throws -> ICAuthSession
    private let restoreSession: () -> ICAuthSession?
    private let saveSession: (ICAuthSession) throws -> Void
    private let clearSession: () -> Void
    private let prefersEphemeralWebBrowserSession: Bool

    init(
        configuration: AppConfiguration,
        prefersEphemeralWebBrowserSession: Bool? = nil
    ) {
        let authenticator = ICInternetIdentityAuthenticator(
            configuration: configuration.icClientConfiguration,
            callbackDomain: configuration.callbackDomain
        )
        let store = KinicAuthSessionStore(configuration: configuration)
        authenticateSession = { prefersEphemeralWebBrowserSession in
            try await authenticator.authenticate(
                prefersEphemeralWebBrowserSession: prefersEphemeralWebBrowserSession
            )
        }
        restoreSession = { store.restore() }
        saveSession = { try store.save($0) }
        clearSession = { store.clear() }
        self.prefersEphemeralWebBrowserSession =
            prefersEphemeralWebBrowserSession
            ?? Self.debugPrefersEphemeralWebBrowserSession(environment: ProcessInfo.processInfo.environment)
    }

    init(
        prefersEphemeralWebBrowserSession: Bool = false,
        authenticateSession: @escaping (Bool) async throws -> ICAuthSession,
        restoreSession: @escaping () -> ICAuthSession? = { nil },
        saveSession: @escaping (ICAuthSession) throws -> Void,
        clearSession: @escaping () -> Void = {}
    ) {
        self.authenticateSession = authenticateSession
        self.restoreSession = restoreSession
        self.saveSession = saveSession
        self.clearSession = clearSession
        self.prefersEphemeralWebBrowserSession = prefersEphemeralWebBrowserSession
    }

    func restore() -> ICAuthSession? {
        restoreSession()
    }

    func signIn(
        verify: (ICAuthSession) async throws -> Void
    ) async throws -> ICAuthSession {
        let session = try await authenticateSession(prefersEphemeralWebBrowserSession)
        try await verify(session)
        try saveSession(session)
        return session
    }

    func signOut() {
        clearSession()
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
