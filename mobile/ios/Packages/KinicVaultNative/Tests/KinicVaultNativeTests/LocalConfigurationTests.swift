import Foundation
import ICNativeClient
import Testing
@testable import KinicVaultNative

@Test("Local Vault configuration rejects remote or insecure endpoints and a mismatched derivation origin")
func localConfigurationBounds() throws {
    let canister = "rrkah-fqaaa-aaaaa-aaaaq-cai"
    let good = ["canister": canister, "apiBaseURL": "https://localhost:9443", "internetIdentityURL": "https://ii.localhost:9443/authorize", "derivationOrigin": "https://\(canister).localhost:9443", "callbackURL": "https://vault.localhost/ios-vault-auth-callback", "rootKeyBase64": ICTrustRoot.mainnet.derEncodedPublicKey.base64EncodedString()]
    #expect(try VaultLocalConfiguration(data: JSONSerialization.data(withJSONObject: good)).client.canisterId == canister)
    for (key, value) in [("apiBaseURL", "http://localhost:8000"), ("apiBaseURL", "https://icp0.io"), ("derivationOrigin", "https://wiki.kinic.xyz"), ("callbackURL", "https://vault.localhost/ios-vault-auth-callback?token=x"), ("callbackURL", "https://vault.localhost:9443/ios-vault-auth-callback")] {
        var bad = good; bad[key] = value
        #expect(throws: (any Error).self) { _ = try VaultLocalConfiguration(data: JSONSerialization.data(withJSONObject: bad)) }
    }
}

@Test("Remote Vault configuration supports production and staging while strictly rejecting Wiki origins")
func remoteConfigurationSeparation() throws {
    let vaultCanister = "rrkah-fqaaa-aaaaa-aaaaq-cai"
    let wikiCanister = "6emaw-iyaaa-aaaay-aacka-cai"

    let prod = try VaultConnectionConfiguration.remote(
        environment: .production,
        canisterId: vaultCanister,
        forbiddenCanisterIds: [wikiCanister],
        forbiddenCallbackDomains: ["wiki.kinic.xyz"]
    )
    #expect(prod.environment == .production)
    #expect(prod.canisterId == vaultCanister)
    #expect(prod.client.derivationOrigin == "https://\(vaultCanister).icp0.io")
    #expect(prod.callbackURL.absoluteString == "https://vault.kinic.xyz/ios-vault-auth-callback")
    #expect(!prod.isLocal)

    let staging = try VaultConnectionConfiguration.remote(
        environment: .staging,
        canisterId: vaultCanister,
        callbackDomain: "vault-staging.kinic.xyz",
        forbiddenCanisterIds: [wikiCanister],
        forbiddenCallbackDomains: ["wiki.kinic.xyz"]
    )
    #expect(staging.environment == .staging)
    #expect(staging.callbackURL.absoluteString == "https://vault-staging.kinic.xyz/ios-vault-auth-callback")

    // Reject reusing Wiki canister ID or Wiki callback domain.
    #expect(throws: VaultConnectionConfigurationError.sharedWithWikiOrigin) {
        _ = try VaultConnectionConfiguration.remote(
            environment: .production,
            canisterId: wikiCanister,
            forbiddenCanisterIds: [wikiCanister],
            forbiddenCallbackDomains: ["wiki.kinic.xyz"]
        )
    }
    #expect(throws: VaultConnectionConfigurationError.sharedWithWikiOrigin) {
        _ = try VaultConnectionConfiguration.remote(
            environment: .staging,
            canisterId: vaultCanister,
            callbackDomain: "wiki.kinic.xyz"
        )
    }
    // Reject mismatched derivation origin.
    #expect(throws: VaultConnectionConfigurationError.invalidDerivationOrigin) {
        _ = try VaultConnectionConfiguration.remote(
            environment: .production,
            canisterId: vaultCanister,
            derivationOrigin: "https://\(wikiCanister).icp0.io"
        )
    }
}
