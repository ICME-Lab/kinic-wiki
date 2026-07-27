// Where: mobile/ios/KinicApp/Views/AskAIEmptyConversationView.swift
// What: Branded empty state and useful grounded-question starters.
// Why: The first screen should teach that Ask AI answers from the selected memory, not the open internet.

import SwiftUI

struct AskAIEmptyConversationView: View {
    @Bindable var model: AskAIModel

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            AskAIMemoryMark()

            VStack(alignment: .leading, spacing: 8) {
                Text("Ask your memory")
                    .font(.largeTitle)
                    .bold()
                Text("Kinic AI searches **\(model.databaseTitle)** and answers only when it finds supporting notes.")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 12) {
                AskAIPromptSuggestion(title: "Summarize the main ideas in this database", model: model)
                AskAIPromptSuggestion(title: "What decisions have been recorded recently?", model: model)
                AskAIPromptSuggestion(title: "Find notes that disagree with each other", model: model)
            }
        }
        .frame(maxWidth: 620, alignment: .leading)
        .padding(.vertical, 40)
    }
}

private struct AskAIMemoryMark: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(KinicDesign.palePink)
                .frame(width: 72, height: 72)
            Circle()
                .stroke(KinicDesign.hotPink, lineWidth: 2)
                .frame(width: 44, height: 44)
            Circle()
                .fill(KinicDesign.hotPink)
                .frame(width: 12, height: 12)
        }
        .accessibilityHidden(true)
    }
}
