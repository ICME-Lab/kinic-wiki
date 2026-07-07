// Where: mobile/ios/KinicApp/Utilities/URLNormalizerError.swift
// What: URL normalization errors.
// Why: Unsupported Share Sheet input should surface a clear user-facing message.

import Foundation

enum URLNormalizerError: LocalizedError, Equatable {
    case unsupportedURL

    var errorDescription: String? {
        switch self {
        case .unsupportedURL:
            "URL must use http or https."
        }
    }
}

