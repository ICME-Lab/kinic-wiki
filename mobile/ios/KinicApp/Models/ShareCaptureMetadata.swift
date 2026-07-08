// Where: mobile/ios/KinicApp/Models/ShareCaptureMetadata.swift
// What: Optional metadata captured from a shared URL before source capture starts.
// Why: Some share sources expose useful page text only through fetched link metadata, not the share payload.

import Foundation

struct ShareCaptureMetadata: Codable, Equatable, Sendable {
    static let xOpenGraphSource = "x_og_metadata"

    let title: String?
    let description: String?
    let imageURL: URL?
    let source: String
    let fetchedAt: Date

    init(
        title: String? = nil,
        description: String? = nil,
        imageURL: URL? = nil,
        source: String,
        fetchedAt: Date = .now
    ) {
        self.title = Self.cleaned(title)
        self.description = Self.cleaned(description)
        self.imageURL = imageURL
        self.source = source
        self.fetchedAt = fetchedAt
    }

    var hasContent: Bool {
        title != nil || description != nil || imageURL != nil
    }

    private static func cleaned(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}
