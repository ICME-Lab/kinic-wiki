import Foundation
import ICNativeClient
import KinicVaultCore

/// Debug-only local configuration. Production Wiki auth configuration is untouched.
public struct VaultLocalConfiguration: Sendable {
    public let client: ICClientConfiguration
    public let callbackURL: URL
    private struct Wire: Decodable {
        let canister: String
        let apiBaseURL: URL
        let internetIdentityURL: URL
        let derivationOrigin: String
        let callbackURL: URL
        let rootKeyBase64: String
    }
    public init(data: Data) throws {
#if DEBUG
        guard data.count <= 16_384 else { throw VaultCryptoError.invalidContext }
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        _ = try ICPPrincipalCodec.decodeText(wire.canister)
        func localHTTPS(_ url: URL) -> Bool {
            guard url.scheme == "https", let host = url.host?.lowercased(), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return false }
            return host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.hasSuffix(".localhost")
        }
        guard let derivation = URL(string: wire.derivationOrigin), localHTTPS(wire.apiBaseURL), localHTTPS(wire.internetIdentityURL), localHTTPS(derivation), derivation.host?.hasPrefix(wire.canister + ".") == true, localHTTPS(wire.callbackURL), wire.callbackURL.host == "vault.localhost", wire.callbackURL.port == nil, wire.callbackURL.path == "/ios-vault-auth-callback", let root = Data(base64Encoded: wire.rootKeyBase64) else { throw VaultCryptoError.invalidContext }
        client = try ICClientConfiguration(canisterId: wire.canister, apiBaseURL: wire.apiBaseURL, internetIdentityURL: wire.internetIdentityURL, derivationOrigin: wire.derivationOrigin, trustRoot: .custom(root))
        callbackURL = wire.callbackURL
#else
        throw VaultCryptoError.invalidContext
#endif
    }
}
