// Where: mobile/ios/KinicTests/KinicAuthSessionStoreTests.swift
// What: Unit tests for shared Keychain query construction.
// Why: App and Share Extension must read the same Internet Identity session.

import Foundation
import ICNativeClient
import Security
import Testing
@testable import Kinic

struct KinicAuthSessionStoreTests {
    @Test
    func baseQueryIncludesKeychainAccessGroup() {
        let configuration = AppConfiguration(
            canisterId: "6emaw-iyaaa-aaaay-aacka-cai",
            apiBaseURL: URL(string: "https://icp0.io")!,
            identityProvider: URL(string: "https://id.ai/authorize")!,
            derivationOrigin: "https://6emaw-iyaaa-aaaay-aacka-cai.icp0.io",
            authOrigin: URL(string: "https://wiki.kinic.xyz")!,
            paymentBaseURL: URL(string: "https://payment.kinic.xyz")!,
            callbackDomain: "wiki.kinic.xyz",
            appGroupId: "group.xyz.kinic.ios.KinicWiki",
            keychainAccessGroup: "AKN976G7AK.xyz.kinic.ios.KinicWiki",
            iapProductIds: [],
            askAIURL: URL(string: "https://api.kinic.io/chat")!,
            deploymentEnvironment: .production
        )

        let store = try! KinicAuthSessionStore(configuration: configuration, service: "test.service")

        #expect(store.accessGroup == "AKN976G7AK.xyz.kinic.ios.KinicWiki")
        #expect(store.service == "test.service")
        #expect(store.account == "internet-identity-session")
    }

    @Test
    func missingSessionRestoresSignedOutStateWithoutClearing() throws {
        var clearCount = 0
        let store = makeStore(
            loadStoredSession: { nil },
            clearStoredSession: { clearCount += 1 }
        )

        #expect(try store.restore() == nil)
        #expect(clearCount == 0)
    }

    @Test
    func keychainReadFailurePreservesStoredSession() {
        var clearCount = 0
        let expected = ICClientError.keychainFailure(errSecInteractionNotAllowed)
        let store = makeStore(
            loadStoredSession: { throw expected },
            clearStoredSession: { clearCount += 1 }
        )

        #expect(throws: expected) {
            try store.restore()
        }
        #expect(clearCount == 0)
    }

    @Test
    func invalidStoredSessionsAreClearedAndRequireAuthentication() {
        let validationErrors: [ICClientError] = [
            .invalidIdentity("invalid identity"),
            .invalidPayload,
            .expiredDelegation,
            .invalidCBOR("invalid delegation certificate"),
            .invalidResponse("invalid delegation witness"),
            .certificateVerificationFailed("invalid delegation signature"),
        ]

        for validationError in validationErrors {
            var clearCount = 0
            let store = makeStore(
                loadStoredSession: { throw validationError },
                clearStoredSession: { clearCount += 1 }
            )

            #expect(throws: KinicAuthSessionStoreError.reauthenticationRequired) {
                try store.restore()
            }
            #expect(clearCount == 1)
        }
    }

    @Test
    func invalidSessionClearFailureSurfacesKeychainFailure() {
        var clearCount = 0
        let expected = ICClientError.keychainFailure(errSecAuthFailed)
        let store = makeStore(
            loadStoredSession: { throw ICClientError.invalidPayload },
            clearStoredSession: {
                clearCount += 1
                throw expected
            }
        )

        #expect(throws: expected) {
            try store.restore()
        }
        #expect(clearCount == 1)
    }

    private func makeStore(
        loadStoredSession: @escaping () throws -> ICAuthSession?,
        clearStoredSession: @escaping () throws -> Void
    ) -> KinicAuthSessionStore {
        KinicAuthSessionStore(
            service: "test.service",
            accessGroup: "AKN976G7AK.xyz.kinic.ios.KinicWiki",
            loadStoredSession: loadStoredSession,
            clearStoredSession: clearStoredSession
        )
    }
}
