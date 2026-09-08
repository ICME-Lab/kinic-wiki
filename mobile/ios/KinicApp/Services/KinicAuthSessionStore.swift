// Where: mobile/ios/KinicApp/Services/KinicAuthSessionStore.swift
// What: Shared ICNativeClient identity storage for the app and Share Extension.
// Why: Both targets must use the same Keychain access group without exposing session private keys.

import Foundation
import ICNativeClient

final class KinicAuthSessionStore: @unchecked Sendable {
    private let loadStoredSession: () throws -> ICAuthSession?
    private let saveStoredSession: (ICAuthSession) throws -> Void
    private let clearStoredSession: () throws -> Void
    let service: String
    let account: String
    let accessGroup: String?

    init(
        configuration: AppConfiguration,
        service: String? = nil,
        account: String = "internet-identity-session"
    ) throws {
        self.service = service ?? "\(configuration.canisterId).kinic-ios"
        self.account = account
        accessGroup = configuration.keychainAccessGroup
        let store = ICIdentityStore(
            configuration: try configuration.makeICClientConfiguration(),
            service: self.service,
            account: account,
            accessGroup: accessGroup
        )
        loadStoredSession = { try store.load() }
        saveStoredSession = { try store.save($0) }
        clearStoredSession = { try store.clear() }
    }

    init(
        service: String,
        account: String = "internet-identity-session",
        accessGroup: String?,
        loadStoredSession: @escaping () throws -> ICAuthSession?,
        saveStoredSession: @escaping (ICAuthSession) throws -> Void = { _ in },
        clearStoredSession: @escaping () throws -> Void
    ) {
        self.service = service
        self.account = account
        self.accessGroup = accessGroup
        self.loadStoredSession = loadStoredSession
        self.saveStoredSession = saveStoredSession
        self.clearStoredSession = clearStoredSession
    }

    func restore() throws -> KinicIdentitySession? {
        do {
            return try loadStoredSession().map(KinicIdentitySession.init(nativeSession:))
        } catch {
            if let clientError = error as? ICClientError,
               case .keychainFailure = clientError {
                throw clientError
            }
            try clearStoredSession()
            throw KinicAuthSessionStoreError.reauthenticationRequired
        }
    }

    func save(_ session: KinicIdentitySession) throws {
        try saveStoredSession(session.requireNativeSession())
    }

    func clear() throws {
        try clearStoredSession()
    }
}

enum KinicAuthSessionStoreError: LocalizedError, Equatable {
    case reauthenticationRequired

    var errorDescription: String? {
        "Your saved sign-in expired or is no longer compatible. Sign in again."
    }
}
