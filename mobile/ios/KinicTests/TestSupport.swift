// Where: mobile/ios/KinicTests/TestSupport.swift
// What: Deterministic test doubles shared by AppModel unit tests.
// Why: Unit tests must not depend on an unsigned simulator's Keychain access.

@testable import Kinic

@MainActor
func makeTestAuthService(
    restoredSession: KinicIdentitySession? = nil,
    clearSession: @escaping () throws -> Void = {}
) -> KinicAuthService {
    KinicAuthService(
        authenticateSession: { _ in .testing(principal: "2vxsx-fae") },
        restoreSession: { restoredSession },
        saveSession: { _ in },
        clearSession: clearSession
    )
}
