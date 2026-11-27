import CryptoKit
import Foundation
import KinicVaultCore
import LocalAuthentication
import Security

public struct VaultKeychainRootStore: Sendable {
    public enum StoreError: Error, Equatable { case keyNotFound, invalidKeyLength, accessControlCreationFailed, osStatus(OSStatus) }
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
    private static func makeAccessControl() throws -> SecAccessControl {
        var error: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .userPresence,
            &error
        ) else {
            throw StoreError.accessControlCreationFailed
        }
        return accessControl
    }
    public func save(rootKey: SymmetricKey) throws {
        var raw = rootKey.withUnsafeBytes { Data($0) }
        defer { raw.resetBytes(in: 0..<raw.count) }
        guard raw.count == 32 else { throw StoreError.invalidKeyLength }
        let accessControl = try Self.makeAccessControl()
        let deleteStatus = SecItemDelete(query() as CFDictionary)
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            throw StoreError.osStatus(deleteStatus)
        }
        var addQuery = query()
        addQuery[kSecValueData as String] = raw
        addQuery[kSecAttrAccessControl as String] = accessControl
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoreError.osStatus(status) }
    }
    public func load(authenticationContext: LAContext? = nil, authenticationPrompt: String? = nil) throws -> SymmetricKey {
        var query = query(); query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        if let authenticationContext {
            query[kSecUseAuthenticationContext as String] = authenticationContext
        } else if let authenticationPrompt {
            let context = LAContext()
            context.localizedReason = authenticationPrompt
            query[kSecUseAuthenticationContext as String] = context
        }
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
    public func load(context: VaultContext) throws -> SymmetricKey { try load(context: context, authenticationContext: nil) }
    public func load(context: VaultContext, authenticationContext: LAContext?) throws -> SymmetricKey {
        try VaultKeychainRootStore(accessGroup: accessGroup, context: context).load(authenticationContext: authenticationContext)
    }
    public func clear() throws { try VaultKeychainRootStore.clearAll(accessGroup: accessGroup) }
}
