// Where: mobile/ios/KinicTests/KinicAuthSessionStoreTests.swift
// What: Unit tests for shared Keychain query construction.
// Why: App and Share Extension must read the same Internet Identity session.

import Foundation
import Security
import Testing
@testable import Kinic

struct KinicAuthSessionStoreTests {
    @Test
    func baseQueryIncludesKeychainAccessGroup() {
        let configuration = AppConfiguration(
            canisterId: "xis3j-paaaa-aaaai-axumq-cai",
            apiBaseURL: URL(string: "https://icp0.io")!,
            derivationOrigin: "https://xis3j-paaaa-aaaai-axumq-cai.icp0.io",
            authOrigin: URL(string: "https://wiki.kinic.xyz")!,
            callbackDomain: "wiki.kinic.xyz",
            appGroupId: "group.xyz.kinic.ios.KinicWiki",
            keychainAccessGroup: "AKN976G7AK.xyz.kinic.ios.KinicWiki",
            openURL: URL(string: "kinicwiki://share")!
        )

        let store = KinicAuthSessionStore(configuration: configuration, service: "test.service")
        let query = store.baseQueryForTesting()

        #expect(query[kSecAttrAccessGroup as String] as? String == "AKN976G7AK.xyz.kinic.ios.KinicWiki")
        #expect(query[kSecAttrService as String] as? String == "test.service")
        #expect(query[kSecAttrAccount as String] as? String == "internet-identity-session")
    }
}
