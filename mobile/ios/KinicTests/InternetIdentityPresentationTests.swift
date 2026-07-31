// Where: mobile/ios/KinicTests/InternetIdentityPresentationTests.swift
// What: Account display regression tests.
// Why: Settings needs the exact copy value while Home shows a compact identifier.

import Testing
@testable import Kinic

struct InternetIdentityPresentationTests {
    @Test
    func signedInPresentationKeepsExactPrincipal() {
        let principal = "eyluy-bu6z2-q5dwg-4sved-2jenz-2r54a-t65kq-y6cz3-kkdrx-ta472-gae"
        let presentation = InternetIdentityPresentation(principal: "  \(principal)  ")

        #expect(presentation.principal == principal)
        #expect(presentation.compactPrincipal == "eyluy…2-gae")
    }

    @Test
    func shortPrincipalIsNotAbbreviated() {
        let presentation = InternetIdentityPresentation(principal: "aaaaa-aa")

        #expect(presentation.compactPrincipal == "aaaaa-aa")
    }

    @Test
    func signedOutPresentationHasNoCopyablePrincipal() {
        let presentation = InternetIdentityPresentation(principal: "  ")

        #expect(presentation.principal == nil)
        #expect(presentation.compactPrincipal == nil)
    }
}
