import CryptoKit
import Foundation
import Security

/// Keychain storage for the Vault AES-256 root key shared between the main Kinic app
/// and the `KinicVaultAutoFill` extension via Keychain Access Groups.
public struct VaultKeychainRootStore: Sendable {
    public enum StoreError: Error, Equatable {
        case keyNotFound
        case invalidKeyLength
        case osStatus(OSStatus)
    }

    private static let service = "xyz.kinic.vault.root-key"
    private static let account = "active-vault-root"

    private let accessGroup: String?

    public init(accessGroup: String?) {
        self.accessGroup = accessGroup?.isEmpty == false ? accessGroup : nil
    }

    public func save(rootKey: SymmetricKey) throws {
        let raw = rootKey.withUnsafeBytes { Data($0) }
        guard raw.count == 32 else { throw StoreError.invalidKeyLength }

        try? delete()

        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecValueData as String: raw,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw StoreError.osStatus(status)
        }
    }

    public func load() throws -> SymmetricKey {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            throw StoreError.keyNotFound
        }
        guard status == errSecSuccess, let data = item as? Data else {
            throw StoreError.osStatus(status)
        }
        guard data.count == 32 else {
            throw StoreError.invalidKeyLength
        }
        return SymmetricKey(data: data)
    }

    public func delete() throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw StoreError.osStatus(status)
        }
    }
}
