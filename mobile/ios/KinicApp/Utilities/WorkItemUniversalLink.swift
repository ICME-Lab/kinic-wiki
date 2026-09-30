// Where: mobile/ios/KinicApp/Utilities/WorkItemUniversalLink.swift
// What: The single universal-link contract between widgets, the app, and tests.
// Why: A widget tap must reach one known path per action without a second URL scheme.

import Foundation

enum WorkItemUniversalLink {
    static let host = "wiki.kinic.xyz"
    static let itemPath = "/ios-work-item"
    static let composePath = "/ios-work-items"
    static let databaseIdQueryItem = "databaseId"
    static let itemIdQueryItem = "itemId"
    static let composeQueryItem = "compose"

    enum Destination: Equatable, Sendable {
        case item(databaseId: String, itemId: String)
        /// `nil` means "use the database the app already has selected".
        case compose(databaseId: String?)
    }

    static func item(databaseId: String, itemId: String, host: String = Self.host) -> URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = itemPath
        components.queryItems = [
            URLQueryItem(name: databaseIdQueryItem, value: databaseId),
            URLQueryItem(name: itemIdQueryItem, value: itemId)
        ]
        return components.url
    }

    static func compose(databaseId: String?, host: String = Self.host) -> URL? {
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = composePath
        var queryItems = [URLQueryItem(name: composeQueryItem, value: "1")]
        if let databaseId, !databaseId.isEmpty {
            queryItems.append(URLQueryItem(name: databaseIdQueryItem, value: databaseId))
        }
        components.queryItems = queryItems
        return components.url
    }

    /// Returns `nil` for every URL that is not one of the work item entry points.
    static func destination(for url: URL, callbackDomain: String) -> Destination? {
        guard url.scheme?.lowercased() == "https",
              url.host?.lowercased() == callbackDomain.lowercased(),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        func queryValue(_ name: String) -> String? {
            guard let value = components.queryItems?.first(where: { $0.name == name })?.value else {
                return nil
            }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        switch components.path {
        case itemPath:
            guard let databaseId = queryValue(databaseIdQueryItem),
                  let itemId = queryValue(itemIdQueryItem) else {
                return nil
            }
            return .item(databaseId: databaseId, itemId: itemId)
        case composePath:
            return .compose(databaseId: queryValue(databaseIdQueryItem))
        default:
            return nil
        }
    }
}
