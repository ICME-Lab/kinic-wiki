// Where: mobile/ios/KinicApp/Models/WikiOutputLanguage.swift
// What: Supported output languages for generated wiki pages.
// Why: App, Share Extension, and worker requests must share a validated language code.

import Foundation

enum WikiOutputLanguage: String, CaseIterable, Codable, Identifiable, Sendable {
    case english = "en"
    case japanese = "ja"
    case simplifiedChinese = "zh-Hans"
    case korean = "ko"
    case spanish = "es"
    case french = "fr"
    case german = "de"
    case portuguese = "pt"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .english:
            "English"
        case .japanese:
            "Japanese"
        case .simplifiedChinese:
            "Chinese (Simplified)"
        case .korean:
            "Korean"
        case .spanish:
            "Spanish"
        case .french:
            "French"
        case .german:
            "German"
        case .portuguese:
            "Portuguese"
        }
    }
}
