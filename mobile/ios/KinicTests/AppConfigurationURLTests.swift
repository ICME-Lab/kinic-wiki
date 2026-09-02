// Where: mobile/ios/KinicTests/AppConfigurationURLTests.swift
// What: URL contract tests for database and isolated public page sharing.
// Why: Shared links must preserve path components without leaking malformed public IDs.

import Foundation
import Testing
@testable import Kinic

struct AppConfigurationURLTests {
    @Test
    func usesDirectInternetIdentityAuthorizationURL() {
        let identityProvider = AppConfiguration.preview.identityProvider
        #expect(identityProvider.scheme == "https")
        #expect(identityProvider.host == "id.ai")
        #expect(identityProvider.path == "/authorize")
        #expect(identityProvider.query == nil)
        #expect(identityProvider.fragment == nil)
    }

    @Test
    func buildsDatabaseNodeURLWithEncodedComponents() {
        let url = AppConfiguration.preview.databaseNodeURL(
            databaseId: "db demo",
            path: "/Knowledge/日本 語.md"
        )
        #expect(url.absoluteString == "https://wiki.kinic.xyz/db/db%20demo/Knowledge/%E6%97%A5%E6%9C%AC%20%E8%AA%9E.md")
    }

    @Test
    func buildsOnlyValidPublicNodeURLs() {
        #expect(
            AppConfiguration.preview.publicNodeURL(publicId: "00112233445566778899aabbccddeeff")?.absoluteString
                == "https://wiki.kinic.xyz/p/00112233445566778899aabbccddeeff"
        )
        #expect(AppConfiguration.preview.publicNodeURL(publicId: "00112233445566778899AABBCCDDEEFF") == nil)
        #expect(AppConfiguration.preview.publicNodeURL(publicId: "too-short") == nil)
    }
}
