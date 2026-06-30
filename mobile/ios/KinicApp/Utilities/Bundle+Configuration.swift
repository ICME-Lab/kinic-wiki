// Where: mobile/ios/KinicApp/Utilities/Bundle+Configuration.swift
// What: Strict Info.plist readers for required runtime values.
// Why: Missing App Store or auth configuration should fail during development.

import Foundation

extension Bundle {
    func requiredString(_ key: String) -> String {
        guard let object = object(forInfoDictionaryKey: key) else {
            fatalError("Missing Info.plist value: \(key)")
        }
        let value = "\(object)"
        guard !value.isEmpty else {
            fatalError("Missing Info.plist value: \(key)")
        }
        return value
    }

    func optionalString(_ key: String) -> String? {
        guard let object = object(forInfoDictionaryKey: key) else {
            return nil
        }
        let value = "\(object)"
        return value.isEmpty ? nil : value
    }

    func requiredURL(_ key: String) -> URL {
        guard let url = URL(string: requiredString(key)) else {
            fatalError("Invalid Info.plist URL: \(key)")
        }
        return url
    }
}
