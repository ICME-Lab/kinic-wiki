import CryptoKit
import Foundation
import KinicVaultCore
import Security

public struct VaultKeychainRootStore: Sendable {
    public enum StoreError: Error, Equatable { case keyNotFound, invalidKeyLength, osStatus(OSStatus) }
    private static let service = "xyz.kinic.vault.root-key"
    private let accessGroup: String?
    private let account: String
    public init(accessGroup: String?, context: VaultContext) throws {
        self.accessGroup = accessGroup?.isEmpty == false ? accessGroup : nil
        account = Base64URL.encode(Data(SHA256.hash(data: try context.contextInput())))
    }
    private func query() -> [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: account]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }
    public func save(rootKey: SymmetricKey) throws {
        var raw = rootKey.withUnsafeBytes { Data($0) }
        defer { raw.resetBytes(in: 0..<raw.count) }
        guard raw.count == 32 else { throw StoreError.invalidKeyLength }
        let value: [String: Any] = [kSecValueData as String: raw, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let updated = SecItemUpdate(query() as CFDictionary, value as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw StoreError.osStatus(updated) }
        let status = SecItemAdd(query().merging(value) { _, new in new } as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoreError.osStatus(status) }
    }
    public func load() throws -> SymmetricKey {
        var query = query(); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { throw StoreError.keyNotFound }
        guard status == errSecSuccess, var raw = item as? Data else { throw StoreError.osStatus(status) }
        defer { raw.resetBytes(in: 0..<raw.count) }
        guard raw.count == 32 else { throw StoreError.invalidKeyLength }
        return SymmetricKey(data: raw)
    }
    public static func clearAll(accessGroup: String?) throws {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let accessGroup, !accessGroup.isEmpty { query[kSecAttrAccessGroup as String] = accessGroup }
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError.osStatus(status) }
    }
}

@MainActor public struct VaultSystemRootKeys: VaultRootKeyStoring {
    private let accessGroup: String?
    public init(accessGroup: String?) { self.accessGroup = accessGroup }
    public func save(_ key: SymmetricKey, context: VaultContext) throws { try VaultKeychainRootStore(accessGroup: accessGroup, context: context).save(rootKey: key) }
    public func load(context: VaultContext) throws -> SymmetricKey { try VaultKeychainRootStore(accessGroup: accessGroup, context: context).load() }
    public func clear() throws { try VaultKeychainRootStore.clearAll(accessGroup: accessGroup) }
}
