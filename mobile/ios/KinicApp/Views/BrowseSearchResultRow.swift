// Where: mobile/ios/KinicApp/Views/BrowseSearchResultRow.swift
// What: Row for a VFS search hit.
// Why: Search results need enough context to choose the right document without opening cards.

import SwiftUI

struct BrowseSearchResultRow: View {
    let hit: SearchNodeHit
    let query: String

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(BrowseSearchText.highlighted(hit.displayName, query: query))
                    .font(.headline)
                    .foregroundStyle(.primary)

                Text(BrowseSearchText.highlighted(hit.displayParentPath, query: query))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if !hit.displayPreview.isEmpty {
                    Text(BrowseSearchText.highlighted(hit.displayPreview, query: query))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }

                if !hit.matchLocationLabel.isEmpty {
                    Label(hit.matchLocationLabel, systemImage: "text.magnifyingglass")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        } icon: {
            Image(systemName: hit.kind.systemImage)
                .foregroundStyle(KinicDesign.hotPink)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(hit.accessibilityDescription)
    }
}
