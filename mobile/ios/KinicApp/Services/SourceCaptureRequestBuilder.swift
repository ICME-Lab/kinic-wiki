// Where: mobile/ios/KinicApp/Services/SourceCaptureRequestBuilder.swift
// What: Builds the native equivalent of wikibrowser source-capture request nodes.
// Why: iOS submissions must preserve the existing worker contract exactly.

import Foundation

enum SourceCaptureRequestBuilder {
    static func request(
        url: URL,
        databaseId: String,
        requestedBy: String,
        requestId: String? = nil,
        now: Date = .now,
        uuid: UUID = UUID(),
        outputLanguage: WikiOutputLanguage = .english,
        captureMetadata: ShareCaptureMetadata? = nil
    ) throws -> SourceCaptureRequest {
        let normalizedURL = try URLNormalizer.normalizedHTTPURL(url)
        let resolvedRequestId: String
        if let requestId {
            resolvedRequestId = try validateRequestId(requestId)
        } else {
            resolvedRequestId = try makeRequestId(now: now, uuid: uuid)
        }
        guard let requestPath = SourceCaptureContract.requestPath(for: resolvedRequestId) else {
            throw SourceCaptureRequestError.invalidRequestId
        }
        let requestedAt = now.formatted(.iso8601)
        let urlText = normalizedURL.absoluteString
        let frontmatter = [
            "---",
            "kind: kinic.source_capture_request",
            "schema_version: 1",
            "status: queued",
            "url: \(jsonString(urlText))",
            "requested_by: \(jsonString(requestedBy))",
            "requested_at: \(jsonString(requestedAt))",
            "output_language: \(jsonString(outputLanguage.rawValue))",
            "claimed_at: null",
            "source_path: null",
            "target_path: null",
            "finished_at: null",
            "error: null"
        ]
        let metadataFrontmatter = captureMetadataFrontmatter(captureMetadata)
        let body = [
            "---",
            "",
            "# Source Capture Request",
            ""
        ] + captureMetadataBody(captureMetadata)
        let content = (frontmatter + metadataFrontmatter + body).joined(separator: "\n")
        var metadataPayload = [
            "request_type": "source_capture",
            "url": urlText,
            "output_language": outputLanguage.rawValue
        ]
        appendCaptureMetadata(captureMetadata, to: &metadataPayload)
        let metadata = try JSONSerialization.data(
            withJSONObject: metadataPayload,
            options: [.sortedKeys]
        )
        let metadataJson = String(data: metadata, encoding: .utf8) ?? "{}"
        return SourceCaptureRequest(
            databaseId: databaseId,
            requestId: resolvedRequestId,
            requestPath: requestPath,
            content: content,
            metadataJson: metadataJson,
            normalizedURL: normalizedURL,
            outputLanguage: outputLanguage
        )
    }

    static func makeRequestId(now: Date = .now, uuid: UUID = UUID()) throws -> String {
        try safeRequestId(timeMs: milliseconds(now), uuid: uuid.uuidString.lowercased())
    }

    static func validateRequestId(_ requestId: String) throws -> String {
        guard isSafeStorageSegment(requestId, maxLength: 128) else {
            throw SourceCaptureRequestError.invalidRequestId
        }
        return requestId
    }

    static func safeRequestId(timeMs: Int64, uuid: String) throws -> String {
        let suffix = uuid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isSafeStorageSegment(suffix, maxLength: 96) else {
            throw SourceCaptureRequestError.invalidRequestId
        }
        let requestId = "\(timeMs)-\(suffix)"
        guard isSafeStorageSegment(requestId, maxLength: 128) else {
            throw SourceCaptureRequestError.invalidRequestId
        }
        return requestId
    }

    private static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1_000).rounded(.down))
    }

    private static func captureMetadataFrontmatter(_ metadata: ShareCaptureMetadata?) -> [String] {
        guard let metadata, metadata.hasContent else {
            return []
        }
        var lines = [
            "shared_metadata_source: \(jsonString(metadata.source))",
            "shared_metadata_fetched_at: \(jsonString(metadata.fetchedAt.formatted(.iso8601)))"
        ]
        if let title = metadata.title {
            lines.append("shared_title: \(jsonString(title))")
        }
        if let description = metadata.description {
            lines.append("shared_description: \(jsonString(description))")
        }
        if let imageURL = metadata.imageURL {
            lines.append("shared_image_url: \(jsonString(imageURL.absoluteString))")
        }
        return lines
    }

    private static func captureMetadataBody(_ metadata: ShareCaptureMetadata?) -> [String] {
        guard let metadata, metadata.hasContent else {
            return []
        }
        var lines = [
            "## Shared Metadata",
            "",
            "Source: \(metadata.source)",
            "Fetched at: \(metadata.fetchedAt.formatted(.iso8601))"
        ]
        if let title = metadata.title {
            lines.append("Title: \(title)")
        }
        if let imageURL = metadata.imageURL {
            lines.append("Image: \(imageURL.absoluteString)")
        }
        if let description = metadata.description {
            lines.append("")
            lines.append("### Description")
            lines.append("")
            lines.append(description)
        }
        lines.append("")
        return lines
    }

    private static func appendCaptureMetadata(
        _ metadata: ShareCaptureMetadata?,
        to payload: inout [String: String]
    ) {
        guard let metadata, metadata.hasContent else {
            return
        }
        payload["shared_metadata_source"] = metadata.source
        payload["shared_metadata_fetched_at"] = metadata.fetchedAt.formatted(.iso8601)
        if let title = metadata.title {
            payload["shared_title"] = title
        }
        if let description = metadata.description {
            payload["shared_description"] = description
        }
        if let imageURL = metadata.imageURL {
            payload["shared_image_url"] = imageURL.absoluteString
        }
    }

    static func isSafeStorageSegment(_ value: String, maxLength: Int = 128) -> Bool {
        maxLength == 128
            ? SourceCaptureContract.isSafeRequestId(value)
            : value.utf8.count <= maxLength && SourceCaptureContract.isSafeRequestId(value)
    }

    private static func jsonString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return text
    }
}
