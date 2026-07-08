// Where: mobile/ios/KinicApp/Views/BrowseDatabaseRow.swift
// What: Compact row for a readable database.
// Why: The sidebar must expose DB title, role, and id without card-style chrome.

import SwiftUI

struct BrowseDatabaseRow: View {
    let database: DatabaseSummary
    let isSelected: Bool
    var isPublicReadable = false
    var isPurchased = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "externaldrive")
                .foregroundStyle(isSelected ? KinicDesign.hotPink : .secondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                Text(database.displayTitle)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                Text(database.role.displayName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                if isPublicReadable || isPurchased {
                    HStack(spacing: 6) {
                        if isPublicReadable {
                            browseBadge("Public")
                        }
                        if isPurchased {
                            browseBadge("Purchased")
                        }
                    }
                }

                Text(database.databaseId)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private func browseBadge(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(KinicDesign.hotPink)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(KinicDesign.hotPink.opacity(0.12), in: Capsule())
    }
}
