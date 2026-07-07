// Where: mobile/ios/KinicApp/Views/BrowseSearchResultRow.swift
// What: Row for a VFS search hit.
// Why: Search results need enough context to choose the right document without opening cards.

import SwiftUI

struct BrowseSearchResultRow: View {
    let hit: SearchNodeHit

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(hit.path)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                if !hit.displayPreview.isEmpty {
                    Text(hit.displayPreview)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
        } icon: {
            Image(systemName: hit.kind.systemImage)
                .foregroundStyle(KinicDesign.hotPink)
        }
        .padding(.vertical, 4)
    }
}
