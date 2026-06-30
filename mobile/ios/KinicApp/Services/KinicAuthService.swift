// Where: mobile/ios/KinicApp/Services/KinicAuthService.swift
// What: Internet Identity login and Keychain session storage.
// Why: App and future canister writes need the same native delegation session.

import Foundation
import ICNativeClient

@MainActor
final class KinicAuthService {
    private let authenticator: ICInternetIdentityAuthenticator
    private let store: ICIdentityStore

    init(configuration: AppConfiguration) {
        authenticator = ICInternetIdentityAuthenticator(
            configuration: configuration.icClientConfiguration,
            authOrigin: configuration.authOrigin,
            callbackDomain: configuration.callbackDomain
        )
        store = ICIdentityStore(
            configuration: configuration.icClientConfiguration,
            service: "\(configuration.canisterId).kinic-ios"
        )
    }

    func restore() -> ICAuthSession? {
        store.load()
    }

    func signIn() async throws -> ICAuthSession {
        let session = try await authenticator.authenticate()
        try store.save(session)
        return session
    }

    func signOut() {
        store.clear()
    }
}

