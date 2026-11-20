// Where: mobile/ios/KinicApp/Services/VaultClipboardHelper.swift
// What: Local-only, expiring clipboard helper for Vault secrets.
// Why: Passwords and 2FA codes must not leak through Universal Clipboard or stay indefinitely.

import Foundation
#if canImport(UIKit)
import UIKit
#endif

enum VaultClipboardKind: Equatable, Sendable {
    case password
    case totp
    case secretField
    case plain

    var expirationSeconds: TimeInterval? {
        switch self {
        case .password, .secretField: 60
        case .totp: 90
        case .plain: nil
        }
    }

    var isLocalOnly: Bool {
        switch self {
        case .password, .totp, .secretField: true
        case .plain: false
        }
    }
}

@MainActor
enum VaultClipboardHelper {
    static func copy(_ value: String, kind: VaultClipboardKind) {
        #if canImport(UIKit)
        if kind.isLocalOnly {
            var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
            if let seconds = kind.expirationSeconds {
                options[.expirationDate] = Date().addingTimeInterval(seconds)
            }
            UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: value]], options: options)
        } else {
            UIPasteboard.general.string = value
        }
        #endif
    }
}
