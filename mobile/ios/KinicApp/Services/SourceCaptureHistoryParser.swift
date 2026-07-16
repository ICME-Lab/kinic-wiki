// Where: mobile/ios/KinicApp/Services/SourceCaptureHistoryParser.swift
// What: Parses and prepares source-capture request nodes written for the Worker.
// Why: read_node is the remote status source and failed requests must be reset with their current ETag.

import Foundation

enum SourceCaptureFrontmatterValue: Equatable, Sendable {
    case null
    case text(String)
}

struct SourceCaptureRetryWrite: Equatable, Sendable {
    let status: SourceCaptureHistoryStatus
    let content: String
    let metadataJson: String
}

struct SourceCaptureRequestNode: Equatable, Sendable {
    let node: VFSNode
    let item: SourceCaptureHistoryItem
    let requestedBy: String
    let requestedAt: String
    let outputLanguage: WikiOutputLanguage
    private let fields: [String: SourceCaptureFrontmatterValue]
    private let fieldOrder: [String]
    private let body: String

    init(
        node: VFSNode,
        item: SourceCaptureHistoryItem,
        requestedBy: String,
        requestedAt: String,
        outputLanguage: WikiOutputLanguage,
        fields: [String: SourceCaptureFrontmatterValue],
        fieldOrder: [String],
        body: String
    ) {
        self.node = node
        self.item = item
        self.requestedBy = requestedBy
        self.requestedAt = requestedAt
        self.outputLanguage = outputLanguage
        self.fields = fields
        self.fieldOrder = fieldOrder
        self.body = body
    }

    var isRetryable: Bool {
        item.isRetryable()
    }

    func retryWrite() -> SourceCaptureRetryWrite {
        let retryStatus: SourceCaptureHistoryStatus = item.sourcePath == nil ? .queued : .sourceWritten
        var retryFields = fields
        retryFields["status"] = .text(retryStatus.workerValue)
        retryFields["claimed_at"] = .null
        retryFields["source_path"] = item.sourcePath.map(SourceCaptureFrontmatterValue.text) ?? .null
        retryFields["target_path"] = .null
        retryFields["finished_at"] = .null
        retryFields["error"] = .null

        return SourceCaptureRetryWrite(
            status: retryStatus,
            content: Self.render(
                fields: retryFields,
                fieldOrder: fieldOrder,
                body: body
            ),
            metadataJson: retryMetadataJson(
                status: retryStatus,
                sourcePath: item.sourcePath
            )
        )
    }

    private func retryMetadataJson(status: SourceCaptureHistoryStatus, sourcePath: String?) -> String {
        guard var metadata = (try? JSONSerialization.jsonObject(with: Data(node.metadataJson.utf8))) as? [String: Any] else {
            return node.metadataJson
        }
        metadata["request_type"] = "source_capture"
        metadata["url"] = item.url
        metadata["status"] = status.workerValue
        metadata["output_language"] = outputLanguage.rawValue
        metadata["source_path"] = sourcePath ?? NSNull()
        metadata["target_path"] = NSNull()
        guard let data = try? JSONSerialization.data(withJSONObject: metadata, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8) else {
            return node.metadataJson
        }
        return value
    }

    private static func render(
        fields: [String: SourceCaptureFrontmatterValue],
        fieldOrder: [String],
        body: String
    ) -> String {
        let requiredFields = [
            "kind",
            "schema_version",
            "status",
            "url",
            "requested_by",
            "requested_at",
            "output_language",
            "claimed_at",
            "source_path",
            "target_path",
            "finished_at",
            "error"
        ]
        let keys = requiredFields + fieldOrder.filter { !requiredFields.contains($0) }
        let lines = keys.compactMap { key -> String? in
            guard let value = fields[key] else { return nil }
            return "\(key): \(format(value))"
        }
        let normalizedBody = body.trimmingCharacters(in: .whitespacesAndNewlines)
        return "---\n\(lines.joined(separator: "\n"))\n---\n\n\(normalizedBody)"
    }

    private static func format(_ value: SourceCaptureFrontmatterValue) -> String {
        switch value {
        case .null:
            return "null"
        case let .text(text):
            guard let data = try? JSONSerialization.data(withJSONObject: text, options: [.fragmentsAllowed]),
                  let json = String(data: data, encoding: .utf8) else {
                return "\"\""
            }
            return json
        }
    }
}

extension SourceCaptureHistoryStatus {
    fileprivate var workerValue: String {
        return switch self {
        case .queued: "queued"
        case .fetching: "fetching"
        case .sourceWritten: "source_written"
        case .generating: "generating"
        case .completed: "completed"
        case .failed: "failed"
        }
    }
}

enum SourceCaptureHistoryParser {
    static func item(from node: VFSNode) throws -> SourceCaptureHistoryItem {
        let parsed = try parse(node: node)
        return try historyItem(from: parsed, node: node)
    }

    static func request(from node: VFSNode) throws -> SourceCaptureRequestNode {
        let parsed = try parse(node: node)
        let item = try historyItem(from: parsed, node: node)
        guard let requestedBy = textValue("requested_by", fields: parsed.fields),
              let outputLanguageValue = textValue("output_language", fields: parsed.fields),
              let outputLanguage = WikiOutputLanguage(rawValue: outputLanguageValue) else {
            throw SourceCaptureHistoryParseError.invalidRequest
        }
        return SourceCaptureRequestNode(
            node: node,
            item: item,
            requestedBy: requestedBy,
            requestedAt: try requiredText("requested_at", fields: parsed.fields),
            outputLanguage: outputLanguage,
            fields: parsed.fields,
            fieldOrder: parsed.fieldOrder,
            body: parsed.body
        )
    }

    private static func historyItem(from parsed: ParsedFrontmatter, node: VFSNode) throws -> SourceCaptureHistoryItem {
        guard let url = textValue("url", fields: parsed.fields),
              let statusValue = textValue("status", fields: parsed.fields),
              let requestedAt = textValue("requested_at", fields: parsed.fields),
              let requestedAtDate = try? Date(requestedAt, strategy: .iso8601) else {
            throw SourceCaptureHistoryParseError.invalidRequest
        }
        guard let parsedStatus = status(from: statusValue) else {
            throw SourceCaptureHistoryParseError.invalidStatus
        }
        return SourceCaptureHistoryItem(
            requestPath: node.path,
            url: url,
            status: parsedStatus,
            requestedAtMilliseconds: Int64((requestedAtDate.timeIntervalSince1970 * 1_000).rounded(.down)),
            updatedAtMilliseconds: node.updatedAt,
            claimedAt: textValue("claimed_at", fields: parsed.fields),
            sourcePath: textValue("source_path", fields: parsed.fields),
            targetPath: textValue("target_path", fields: parsed.fields),
            finishedAt: textValue("finished_at", fields: parsed.fields),
            error: textValue("error", fields: parsed.fields),
            lastCheckedAtMilliseconds: nil,
            syncError: nil
        )
    }

    private static func parse(node: VFSNode) throws -> ParsedFrontmatter {
        guard node.kind == .file else {
            throw SourceCaptureHistoryParseError.invalidKind
        }
        let parsed = try frontmatter(from: node.content)
        guard textValue("kind", fields: parsed.fields) == "kinic.source_capture_request",
              textValue("schema_version", fields: parsed.fields) == "1" else {
            throw SourceCaptureHistoryParseError.invalidRequest
        }
        return parsed
    }

    private static func requiredText(
        _ key: String,
        fields: [String: SourceCaptureFrontmatterValue]
    ) throws -> String {
        guard let value = textValue(key, fields: fields) else {
            throw SourceCaptureHistoryParseError.invalidRequest
        }
        return value
    }

    private static func textValue(
        _ key: String,
        fields: [String: SourceCaptureFrontmatterValue]
    ) -> String? {
        guard case let .text(value) = fields[key] else { return nil }
        return value
    }

    private static func status(from value: String) -> SourceCaptureHistoryStatus? {
        switch value {
        case "queued": .queued
        case "fetching": .fetching
        case "source_written": .sourceWritten
        case "generating": .generating
        case "completed": .completed
        case "failed": .failed
        default: nil
        }
    }

    private static func frontmatter(from content: String) throws -> ParsedFrontmatter {
        guard content.hasPrefix("---\n") else {
            throw SourceCaptureHistoryParseError.invalidFrontmatter
        }
        let searchStart = content.index(content.startIndex, offsetBy: 4)
        guard let marker = content.range(of: "\n---", range: searchStart..<content.endIndex) else {
            throw SourceCaptureHistoryParseError.invalidFrontmatter
        }
        let afterMarker = marker.upperBound
        guard afterMarker == content.endIndex || content[afterMarker] == "\n" else {
            throw SourceCaptureHistoryParseError.invalidFrontmatter
        }
        let header = content[searchStart..<marker.lowerBound]
        var fields: [String: SourceCaptureFrontmatterValue] = [:]
        var fieldOrder: [String] = []
        for line in header.split(separator: "\n", omittingEmptySubsequences: true) {
            let components = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
            guard components.count == 2 else {
                throw SourceCaptureHistoryParseError.invalidFrontmatter
            }
            let key = String(components[0]).trimmingCharacters(in: .whitespaces)
            let rawValue = String(components[1]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else {
                throw SourceCaptureHistoryParseError.invalidFrontmatter
            }
            guard !fieldOrder.contains(key) else {
                throw SourceCaptureHistoryParseError.invalidFrontmatter
            }
            fieldOrder.append(key)
            if rawValue == "null" {
                fields[key] = .null
            } else if rawValue.first == "\"" {
                guard let data = rawValue.data(using: .utf8),
                      let value = try? JSONDecoder().decode(String.self, from: data) else {
                    throw SourceCaptureHistoryParseError.invalidFrontmatter
                }
                fields[key] = .text(value)
            } else {
                fields[key] = .text(rawValue)
            }
        }
        return ParsedFrontmatter(
            fields: fields,
            fieldOrder: fieldOrder,
            body: String(content[afterMarker...])
        )
    }

    private struct ParsedFrontmatter: Equatable, Sendable {
        let fields: [String: SourceCaptureFrontmatterValue]
        let fieldOrder: [String]
        let body: String
    }
}

enum SourceCaptureHistoryParseError: LocalizedError, Equatable {
    case invalidFrontmatter
    case invalidKind
    case invalidRequest
    case invalidStatus

    var errorDescription: String? {
        switch self {
        case .invalidFrontmatter:
            "Source capture request frontmatter is invalid."
        case .invalidKind:
            "Source capture request node is not a file."
        case .invalidRequest:
            "Source capture request fields are invalid."
        case .invalidStatus:
            "Source capture request status is invalid."
        }
    }
}
