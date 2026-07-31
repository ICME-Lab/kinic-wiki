// Where: mobile/ios/KinicTests/KinicAuthServiceTests.swift
// What: Debug-only authentication session option regression tests.
// Why: Review reproduction needs a clean browser session without changing Release SSO behavior.

import Testing
@testable import Kinic

struct KinicAuthServiceTests {
    @Test
    func ephemeralAuthenticationRequiresExplicitDebugEnvironment() {
        #expect(KinicAuthService.debugPrefersEphemeralWebBrowserSession(environment: [:]) == false)
        #expect(
            KinicAuthService.debugPrefersEphemeralWebBrowserSession(
                environment: ["KINIC_EPHEMERAL_AUTH": "1"]
            )
        )
        #expect(
            KinicAuthService.debugPrefersEphemeralWebBrowserSession(
                environment: ["KINIC_EPHEMERAL_AUTH": "0"]
            ) == false
        )
    }
}
