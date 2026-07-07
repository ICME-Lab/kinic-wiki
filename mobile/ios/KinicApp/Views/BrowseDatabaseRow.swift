// Where: mobile/ios/KinicApp/Views/BrowseDatabaseRow.swift
// What: Compact row for a readable database.
// Why: The sidebar must expose DB title, role, and id without card-style chrome.

import SwiftUI

struct BrowseDatabaseRow: View {
    let database: DatabaseSummary
    let isSelected: Bool

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
}
