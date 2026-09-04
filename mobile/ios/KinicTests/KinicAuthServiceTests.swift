// Where: mobile/ios/KinicTests/KinicAuthServiceTests.swift
// What: Authentication browser options and pre-persistence session verification tests.
// Why: Unverified ICRC-167 sessions must never become shared Keychain state.

import Foundation
import ICNativeClient
import Testing
@testable import Kinic

struct KinicAuthServiceTests {
    private struct VerificationFailure: Error {}

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

    @MainActor
    @Test
    func savesOnlyAfterSignedSessionVerificationSucceeds() async throws {
        let expected = authSession()
        var events: [String] = []
        let service = KinicAuthService(
            authenticateSession: { isEphemeral in
                #expect(isEphemeral == false)
                events.append("authenticate")
                return expected
            },
            saveSession: { session in
                #expect(session == expected)
                events.append("save")
            }
        )

        let actual = try await service.signIn { session in
            #expect(session == expected)
            events.append("verify")
        }

        #expect(actual == expected)
        #expect(events == ["authenticate", "verify", "save"])
    }

    @MainActor
    @Test
    func doesNotSaveWhenSignedSessionVerificationFails() async {
        let expected = authSession()
        var didSave = false
        let service = KinicAuthService(
            authenticateSession: { _ in expected },
            saveSession: { _ in didSave = true }
        )

        do {
            _ = try await service.signIn { _ in throw VerificationFailure() }
            Issue.record("Expected signed session verification to fail")
        } catch is VerificationFailure {
            #expect(didSave == false)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    @MainActor
    @Test
    func doesNotSaveWhenAuthenticationIsCancelled() async {
        var didVerify = false
        var didSave = false
        let service = KinicAuthService(
            authenticateSession: { _ in throw CancellationError() },
            saveSession: { _ in didSave = true }
        )

        do {
            _ = try await service.signIn { _ in didVerify = true }
            Issue.record("Expected authentication to be cancelled")
        } catch is CancellationError {
            #expect(didVerify == false)
            #expect(didSave == false)
        } catch {
            Issue.record("Unexpected error: \(error)")
        }
    }

    private func authSession() -> KinicIdentitySession {
        .testing(principal: "2vxsx-fae")
    }
}
