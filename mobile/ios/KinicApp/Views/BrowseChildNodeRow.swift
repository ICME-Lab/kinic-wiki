// Where: mobile/ios/KinicApp/Views/BrowseChildNodeRow.swift
// What: Row for a child folder, file, or source node.
// Why: Node lists need a dense, native list style matching Notes-like navigation.

import SwiftUI

struct BrowseChildNodeRow: View {
    let child: ChildNode

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 3) {
                Text(child.name)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                Text(child.path)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        } icon: {
            Image(systemName: child.kind.systemImage)
                .foregroundStyle(KinicDesign.hotPink)
        }
        .padding(.vertical, 4)
    }
}
