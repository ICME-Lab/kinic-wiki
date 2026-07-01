// Where: mobile/ios/KinicApp/Services/KinicAuthSessionStore.swift
// What: Shared Keychain storage for Internet Identity auth sessions.
// Why: The app and Share Extension need the same delegation session for best-effort capture.

import Foundation
import ICNativeClient
import Security

final class KinicAuthSessionStore: @unchecked Sendable {
    private let configuration: ICClientConfiguration
    private let service: String
    private let account: String
    private let accessGroup: String?

    init(
        configuration: AppConfiguration,
        service: String? = nil,
        account: String = "internet-identity-session"
    ) {
        self.configuration = configuration.icClientConfiguration
        self.service = service ?? "\(configuration.canisterId).kinic-ios"
        self.account = account
        accessGroup = configuration.keychainAccessGroup
    }

    func restore() -> ICAuthSession? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let session = try? JSONDecoder().decode(ICAuthSession.self, from: data) else {
            return nil
        }
        do {
            try ICIdentityBridge.validateSession(session, configuration: configuration)
            return session
        } catch {
            clear()
            return nil
        }
    }

    func save(_ session: ICAuthSession) throws {
        try ICIdentityBridge.validateSession(session, configuration: configuration)
        let data = try JSONEncoder().encode(session)
        clear()
        var query = baseQuery()
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = ICIdentityStore.keychainAccessibility
        let status = SecItemAdd(query as CFDictionary, nil)
        if status != errSecSuccess {
            throw ICClientError.keychainFailure(status)
        }
    }

    func clear() {
        SecItemDelete(baseQuery() as CFDictionary)
    }

    func baseQueryForTesting() -> [String: Any] {
        baseQuery()
    }

    private func baseQuery() -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        if let accessGroup,
           !accessGroup.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }
}
