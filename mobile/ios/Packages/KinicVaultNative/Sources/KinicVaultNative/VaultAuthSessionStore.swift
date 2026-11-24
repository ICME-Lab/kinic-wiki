import Foundation
import ICNativeClient

/// Dedicated Keychain store for Vault Internet Identity delegations.
/// Strictly isolated from Wiki's Keychain service (`<wikiCanister>.kinic-ios`).
public final class VaultAuthSessionStore: @unchecked Sendable {
    private let store: ICIdentityStore
    public let service: String
    public let account: String
    public let accessGroup: String?

    public init(
        configuration: VaultConnectionConfiguration,
        accessGroup: String?,
        account: String = "vault-internet-identity-session"
    ) {
        self.service = "xyz.kinic.vault.session.\(configuration.canisterId)"
        self.account = account
        self.accessGroup = accessGroup?.isEmpty == false ? accessGroup : nil
        self.store = ICIdentityStore(
            configuration: configuration.client,
            service: self.service,
            account: account,
            accessGroup: self.accessGroup
        )
    }

    public func load() throws -> ICAuthSession? {
        do {
            return try store.load()
        } catch {
            if let clientError = error as? ICClientError,
               case .keychainFailure = clientError {
                throw clientError
            }
            try? store.clear()
            return nil
        }
    }

    public func save(_ session: ICAuthSession) throws {
        try store.save(session)
    }

    public func clear() throws {
        try store.clear()
    }
}
