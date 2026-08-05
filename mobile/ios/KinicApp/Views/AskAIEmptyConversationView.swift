// Where: mobile/ios/KinicApp/Views/AskAIEmptyConversationView.swift
// What: Branded database-selection state and useful Ask AI starters.
// Why: The first screen should make the required database scope clear before chatting.

import SwiftUI

struct AskAIEmptyConversationView: View {
    @Bindable var model: AskAIModel

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            AskAIMemoryMark()

            VStack(alignment: .leading, spacing: 8) {
                Text(model.currentConversation == nil ? "Select a database" : "Ask your memory")
                    .font(.largeTitle)
                    .bold()
                if model.currentConversation == nil {
                    Text("Choose a database with Select DB above to start chatting.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Kinic AI can chat normally and searches **\(model.databaseTitle)** when your question needs supporting notes.")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
            }

            if model.currentConversation != nil {
                VStack(alignment: .leading, spacing: 12) {
                    AskAIPromptSuggestion(title: "Summarize the main ideas in this database", model: model)
                    AskAIPromptSuggestion(title: "What decisions have been recorded recently?", model: model)
                    AskAIPromptSuggestion(title: "Find notes that disagree with each other", model: model)
                }
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
