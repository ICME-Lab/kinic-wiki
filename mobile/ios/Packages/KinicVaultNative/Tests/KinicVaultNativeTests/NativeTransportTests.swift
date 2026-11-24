import CryptoKit
import Foundation
import Testing
import KinicVaultCore
@testable import KinicVaultNative

@Test("Native transport refuses unanchored replies and mismatched context")
func rejectsInvalidRootReply() throws {
    let context = try VaultContext(canister: "rrkah-fqaaa-aaaaa-aaaaq-cai", owner: "rrkah-fqaaa-aaaaa-aaaaq-cai", vault: Data(repeating: 1, count: 16), nonce: Data(repeating: 2, count: 32), keyName: "test_key_1")
    let transport = try VaultNativeTransport()
    #expect(transport.publicKey.count == 48)
    #expect(throws: VaultCryptoError.invalidContext) {
        _ = try transport.rootKey(context: context, headerPublicKey: Data(repeating: 0, count: 96), replyInput: Data(), replyPublicKey: Data(repeating: 0, count: 96), encryptedKey: Data(repeating: 0, count: 192), local: true)
    }
    #expect(throws: VaultCryptoError.invalidContext) {
        _ = try transport.rootKey(context: context, headerPublicKey: Data(repeating: 0, count: 96), replyInput: context.contextInput(), replyPublicKey: Data(repeating: 0, count: 96), encryptedKey: Data(repeating: 0, count: 192), local: true)
    }
}
