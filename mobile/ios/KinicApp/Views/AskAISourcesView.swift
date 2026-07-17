// Where: mobile/ios/KinicApp/Views/AskAISourcesView.swift
// What: Deterministic evidence cards attached to an Ask AI result.
// Why: Users should be able to inspect the exact DB nodes considered or cited.

import SwiftUI

struct AskAISourcesView: View {
    let sources: [AskAISource]
    let openSource: (AskAISource) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Sources")
                .font(.headline)

            ForEach(sources) { source in
                Button {
                    openSource(source)
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Label(source.displayName, systemImage: "doc.text")
                            .font(.subheadline)
                            .bold()
                        Text(source.path)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        if !source.excerpt.isEmpty {
                            Text(source.excerpt)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(KinicDesign.panelBackground)
                    .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens this note in Browse")
            }
        }
    }
}
