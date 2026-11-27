#if os(iOS)
import AuthenticationServices
import KinicVaultCore

@MainActor public struct VaultSystemIdentityStore: VaultIdentityRegistering {
    public init() {}
    public var isEnabled: Bool { get async { await ASCredentialIdentityStore.shared.state().isEnabled } }
    public func replaceAll(_ candidates: [VaultAutoFillCandidate]) async throws {
        let store = ASCredentialIdentityStore.shared
        if candidates.isEmpty {
            guard await isEnabled else { return }
            try await store.removeAllCredentialIdentities()
            return
        }
        guard await isEnabled else { throw VaultNativeError.providerDisabled }
        var identities: [any ASCredentialIdentity] = []
        for candidate in candidates {
            for domain in candidate.domains {
                identities.append(ASPasswordCredentialIdentity(serviceIdentifier: ASCredentialServiceIdentifier(identifier: domain, type: .domain), user: candidate.username.isEmpty ? candidate.title : candidate.username, recordIdentifier: candidate.recordIdentifier))
            }
        }
        try await store.replaceCredentialIdentities(identities)
    }
}
#endif
