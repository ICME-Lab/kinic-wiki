// Where: mobile/ios/KinicApp/Services/KinicAuthService.swift
// What: Internet Identity login and Keychain session storage.
// Why: App and future canister writes need the same native delegation session.

import Foundation
import ICNativeClient

@MainActor
final class KinicAuthService {
    private let authenticator: ICInternetIdentityAuthenticator
    private let store: KinicAuthSessionStore
    private let prefersEphemeralWebBrowserSession: Bool

    init(
        configuration: AppConfiguration,
        prefersEphemeralWebBrowserSession: Bool? = nil
    ) {
        authenticator = ICInternetIdentityAuthenticator(
            configuration: configuration.icClientConfiguration,
            authOrigin: configuration.authOrigin,
            callbackDomain: configuration.callbackDomain
        )
        store = KinicAuthSessionStore(configuration: configuration)
        self.prefersEphemeralWebBrowserSession =
            prefersEphemeralWebBrowserSession
            ?? Self.debugPrefersEphemeralWebBrowserSession(environment: ProcessInfo.processInfo.environment)
    }

    func restore() -> ICAuthSession? {
        store.restore()
    }

    func signIn() async throws -> ICAuthSession {
        let session = try await authenticator.authenticate(
            prefersEphemeralWebBrowserSession: prefersEphemeralWebBrowserSession
        )
        try store.save(session)
        return session
    }

    func signOut() {
        store.clear()
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
