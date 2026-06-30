// Where: mobile/ios/KinicApp/Utilities/URLNormalizer.swift
// What: URL normalization shared by native capture request generation.
// Why: iOS must match the browser extension and web app URL contract.

import Foundation

enum URLNormalizer {
    static func normalizedHTTPURL(_ url: URL) throws -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme == "http" || components.scheme == "https",
              components.host != nil else {
            throw URLNormalizerError.unsupportedURL
        }
        components.fragment = nil
        guard let normalized = components.url else {
            throw URLNormalizerError.unsupportedURL
        }
        return normalized
    }
}

