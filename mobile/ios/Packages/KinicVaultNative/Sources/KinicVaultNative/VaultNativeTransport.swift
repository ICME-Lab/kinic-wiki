import CryptoKit
import CVaultVetKeys
import Foundation
import KinicVaultCore
import Security

/// Ephemeral transport scalar is allocated once and overwritten before release.
/// Methods read immutable secret memory; the owning actor decides retry lifetime.
public final class VaultNativeTransport: @unchecked Sendable {
    private let secret: UnsafeMutablePointer<UInt8>
    public let publicKey: Data

    public init() throws {
        let secret = UnsafeMutablePointer<UInt8>.allocate(capacity: 32)
        secret.initialize(repeating: 0, count: 32)
        var seed = [UInt8](repeating: 0, count: 32)
        defer { _ = seed.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        guard SecRandomCopyBytes(kSecRandomDefault, seed.count, &seed) == errSecSuccess else {
            secret.deallocate()
            throw VaultCryptoError.randomFailure
        }
        var publicBytes = [UInt8](repeating: 0, count: 48)
        let status = seed.withUnsafeBufferPointer { kinic_vault_transport($0.baseAddress, secret, &publicBytes) }
        guard status == 0 else {
            secret.initialize(repeating: 0, count: 32)
            secret.deallocate()
            throw VaultCryptoError.invalidContext
        }
        self.secret = secret
        self.publicKey = Data(publicBytes)
    }

    deinit {
        secret.initialize(repeating: 0, count: 32)
        secret.deallocate()
    }

    public func rootKey(context: VaultContext, headerPublicKey: Data, replyInput: Data, replyPublicKey: Data, encryptedKey: Data, local: Bool) throws -> SymmetricKey {
        let input = try context.contextInput()
        guard replyInput == input, headerPublicKey.count == 96, replyPublicKey.count == 96, encryptedKey.count == 192 else {
            throw VaultCryptoError.invalidContext
        }
        var request = Data()
        for field in [try ICPPrincipalCodec.decodeText(context.canister), Data(context.keyName.utf8), input, headerPublicKey, replyPublicKey, encryptedKey] {
            var length = UInt32(field.count).bigEndian
            request.append(Data(bytes: &length, count: 4))
            request.append(field)
        }
        var root = [UInt8](repeating: 0, count: 32)
        defer { _ = root.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
        let status = request.withUnsafeBytes { kinic_vault_root(secret, $0.bindMemory(to: UInt8.self).baseAddress, request.count, local, &root) }
        guard status == 0 else { throw VaultCryptoError.invalidContext }
        return SymmetricKey(data: root)
    }
}
