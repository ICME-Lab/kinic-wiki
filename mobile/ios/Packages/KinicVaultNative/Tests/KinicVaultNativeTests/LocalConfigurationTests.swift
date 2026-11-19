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
