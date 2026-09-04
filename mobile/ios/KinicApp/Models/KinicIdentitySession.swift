// Where: mobile/ios/KinicApp/Models/KinicIdentitySession.swift
// What: App-owned authenticated identity boundary around ICNativeClient sessions.
// Why: Production calls need the sealed native session while app tests only need an authenticated principal.

import Foundation
import ICNativeClient

struct KinicIdentitySession: Equatable, Sendable {
    let principal: String
    private let nativeSession: ICAuthSession?

    init(nativeSession: ICAuthSession) {
        principal = nativeSession.principal
        self.nativeSession = nativeSession
    }

#if DEBUG
    static func testing(principal: String = "2vxsx-fae") -> KinicIdentitySession {
        KinicIdentitySession(principal: principal, nativeSession: nil)
    }
#endif

    func requireNativeSession() throws -> ICAuthSession {
        guard let nativeSession else {
            throw KinicIdentitySessionError.missingNativeSession
        }
        return nativeSession
    }

    private init(principal: String, nativeSession: ICAuthSession?) {
        self.principal = principal
        self.nativeSession = nativeSession
    }
}

private enum KinicIdentitySessionError: LocalizedError {
    case missingNativeSession

    var errorDescription: String? {
        "Authenticated native session is unavailable."
    }
}
