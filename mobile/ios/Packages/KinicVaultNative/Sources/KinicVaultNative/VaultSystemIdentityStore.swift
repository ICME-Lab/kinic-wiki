#if os(iOS)
import AuthenticationServices
import KinicVaultCore

@MainActor public struct VaultSystemIdentityStore: VaultIdentityRegistering {
    public init() {}
    public func replaceAll(_ candidates: [VaultAutoFillCandidate]) async throws {
        let store = ASCredentialIdentityStore.shared
        let state = await store.state()
        guard state.isEnabled else { return }
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
