// Where: mobile/ios/KinicApp/Views/BrowseDatabaseRow.swift
// What: Compact row for a readable database.
// Why: The sidebar must expose DB title, role, and visibility without card-style chrome.

import SwiftUI

struct BrowseDatabaseRow: View {
    let database: DatabaseSummary
    let isSelected: Bool
    var isPublicReadable = false
    var isPurchased = false
    var showsCyclesBalance = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "externaldrive")
                .foregroundStyle(isSelected ? KinicDesign.hotPink : .secondary)
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(database.displayTitle)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .layoutPriority(1)

                    Spacer(minLength: 8)

                    if database.status == .pending || isPublicReadable || isPurchased {
                        HStack(spacing: 6) {
                            if database.status == .pending {
                                browseBadge("Pending")
                            }
                            if isPublicReadable {
                                browseBadge("Public")
                            }
                            if isPurchased {
                                browseBadge("Purchased")
                            }
                        }
                        .fixedSize()
                    }
                }

                Text(showsCyclesBalance ? database.roleAndCyclesBalanceText : database.role.displayName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private func browseBadge(_ text: String) -> some View {
        Text(text)
            .font(.caption.bold())
            .foregroundStyle(KinicDesign.hotPink)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(KinicDesign.hotPink.opacity(0.12), in: Capsule())
    }
}
