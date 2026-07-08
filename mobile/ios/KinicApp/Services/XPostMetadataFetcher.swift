// Where: mobile/ios/KinicApp/Services/XPostMetadataFetcher.swift
// What: API-free Open Graph metadata fetcher for normal X/Twitter post URLs.
// Why: iOS Share payloads do not reliably include post text, while X pages often expose it as og:description.

import Foundation

struct XPostMetadataFetcher: Sendable {
    private let fetchHTML: @Sendable (URL) async throws -> String

    init(fetchHTML: @escaping @Sendable (URL) async throws -> String = XPostMetadataFetcher.liveFetchHTML) {
        self.fetchHTML = fetchHTML
    }

    func metadata(for url: URL, timeout: Duration = .seconds(2)) async -> ShareCaptureMetadata? {
        guard Self.isSupportedPostURL(url) else {
            return nil
        }
        do {
            let html = try await Self.withTimeout(timeout) {
                try await fetchHTML(url)
            }
            return Self.metadata(fromHTML: html, fetchedAt: .now)
        } catch {
            return nil
        }
    }

    static func isSupportedPostURL(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host?.lowercased(),
              ["x.com", "www.x.com", "twitter.com", "www.twitter.com"].contains(host) else {
            return false
        }
        let segments = url.path.split(separator: "/").map(String.init)
        guard segments.count >= 3,
              !segments[0].isEmpty,
              segments[1] == "status",
              !segments[2].isEmpty else {
            return false
        }
        return segments[2].allSatisfy(\.isNumber)
    }

    static func metadata(fromHTML html: String, fetchedAt: Date) -> ShareCaptureMetadata? {
        let title = metaContent(in: html, property: "og:title")
        let description = metaContent(in: html, property: "og:description")
            ?? metaContent(in: html, name: "description")
        let imageURL = metaContent(in: html, property: "og:image").flatMap(URL.init(string:))
        let metadata = ShareCaptureMetadata(
            title: title,
            description: description,
            imageURL: imageURL,
            source: ShareCaptureMetadata.xOpenGraphSource,
            fetchedAt: fetchedAt
        )
        return metadata.hasContent ? metadata : nil
    }

    private static func liveFetchHTML(_ url: URL) async throws -> String {
        var request = URLRequest(url: url)
        request.setValue(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
            forHTTPHeaderField: "User-Agent"
        )
        request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              200..<300 ~= httpResponse.statusCode else {
            throw XPostMetadataFetcherError.invalidResponse
        }
        if let html = String(data: data, encoding: .utf8) {
            return html
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func metaContent(in html: String, property: String) -> String? {
        metaContent(in: html) { attributes in
            attributes["property"] == property
        }
    }

    private static func metaContent(in html: String, name: String) -> String? {
        metaContent(in: html) { attributes in
            attributes["name"] == name
        }
    }

    private static func metaContent(
        in html: String,
        matches: ([String: String]) -> Bool
    ) -> String? {
        let pattern = #"<meta\b[^>]*>"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(html.startIndex..<html.endIndex, in: html)
        let metaMatches = regex.matches(in: html, range: range)
        for match in metaMatches {
            guard let tagRange = Range(match.range, in: html) else {
                continue
            }
            let attributes = metaAttributes(in: String(html[tagRange]))
            guard matches(attributes),
                  let content = attributes["content"] else {
                continue
            }
            return decodedHTML(content)
        }
        return nil
    }

    private static func metaAttributes(in tag: String) -> [String: String] {
        let pattern = #"([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(["'])(.*?)\2"#
        guard let regex = try? NSRegularExpression(
            pattern: pattern,
            options: [.caseInsensitive, .dotMatchesLineSeparators]
        ) else {
            return [:]
        }
        let range = NSRange(tag.startIndex..<tag.endIndex, in: tag)
        var attributes: [String: String] = [:]
        for match in regex.matches(in: tag, range: range) {
            guard let keyRange = Range(match.range(at: 1), in: tag),
                  let valueRange = Range(match.range(at: 3), in: tag) else {
                continue
            }
            attributes[String(tag[keyRange]).lowercased()] = String(tag[valueRange])
        }
        return attributes
    }

    private static func decodedHTML(_ value: String) -> String {
        var output = ""
        var index = value.startIndex
        while let ampersand = value[index...].firstIndex(of: "&") {
            output.append(contentsOf: value[index..<ampersand])
            guard let semicolon = value[ampersand...].firstIndex(of: ";") else {
                output.append(contentsOf: value[ampersand...])
                return output
            }
            let entityStart = value.index(after: ampersand)
            let entity = String(value[entityStart..<semicolon])
            output.append(contentsOf: decodedEntity(entity) ?? String(value[ampersand...semicolon]))
            index = value.index(after: semicolon)
        }
        output.append(contentsOf: value[index...])
        return output
    }

    private static func decodedEntity(_ entity: String) -> String? {
        switch entity {
        case "amp":
            return "&"
        case "quot":
            return "\""
        case "apos", "#39":
            return "'"
        case "lt":
            return "<"
        case "gt":
            return ">"
        case "nbsp":
            return " "
        default:
            return decodedNumericEntity(entity)
        }
    }

    private static func decodedNumericEntity(_ entity: String) -> String? {
        let scalarValue: UInt32?
        if entity.lowercased().hasPrefix("#x") {
            scalarValue = UInt32(entity.dropFirst(2), radix: 16)
        } else if entity.hasPrefix("#") {
            scalarValue = UInt32(entity.dropFirst(), radix: 10)
        } else {
            scalarValue = nil
        }
        guard let scalarValue,
              let scalar = UnicodeScalar(scalarValue) else {
            return nil
        }
        return String(scalar)
    }

    private static func withTimeout<T: Sendable>(
        _ timeout: Duration,
        operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask {
                try await operation()
            }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw XPostMetadataFetcherError.timeout
            }
            guard let value = try await group.next() else {
                throw XPostMetadataFetcherError.timeout
            }
            group.cancelAll()
            return value
        }
    }
}

private enum XPostMetadataFetcherError: Error {
    case invalidResponse
    case timeout
}
