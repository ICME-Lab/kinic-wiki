// Where: mobile/ios/KinicApp/Models/InternetIdentityPresentation.swift
// What: Normalized Internet Identity principal values for account presentation.
// Why: Settings needs the exact value while Home needs a compact identifier.

import Foundation

struct InternetIdentityPresentation: Equatable {
    let principal: String?

    var compactPrincipal: String? {
        guard let principal else {
            return nil
        }
        guard principal.count > 10 else {
            return principal
        }
        return "\(principal.prefix(5))…\(principal.suffix(5))"
    }

    init(principal: String?) {
        let normalizedPrincipal = principal?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let normalizedPrincipal, !normalizedPrincipal.isEmpty {
            self.principal = normalizedPrincipal
        } else {
            self.principal = nil
        }
    }
}
