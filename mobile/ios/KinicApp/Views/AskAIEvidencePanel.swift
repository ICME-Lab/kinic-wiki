// Where: mobile/ios/KinicApp/Views/AskAIEvidencePanel.swift
// What: Persistent evidence rail for regular-width Ask AI layouts.
// Why: iPad users can compare an answer with its DB sources without expanding inline cards.

import SwiftUI

struct AskAIEvidencePanel: View {
    @Bindable var model: AskAIModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Label("Evidence", systemImage: "checkmark.seal")
                    .font(.headline)

                if model.currentSources.isEmpty {
                    ContentUnavailableView(
                        "No evidence yet",
                        systemImage: "doc.text.magnifyingglass",
                        description: Text("Sources used by the latest answer appear here.")
                    )
                } else {
                    AskAISourcesView(
                        heading: "Sources cited by Kinic AI",
                        sources: model.currentSources,
                        openSource: model.openSource
                    )
                }
            }
            .padding(KinicDesign.screenPadding)
        }
        .background(KinicDesign.panelBackground)
    }
}
