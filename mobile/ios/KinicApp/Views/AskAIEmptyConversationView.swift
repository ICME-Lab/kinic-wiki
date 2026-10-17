// Where: mobile/ios/KinicApp/Views/AskAIEmptyConversationView.swift
// What: Branded database-selection state and useful Ask AI starters.
// Why: The first screen should make the required database scope clear before chatting.

import SwiftUI

struct AskAIEmptyConversationView: View {
    @Bindable var model: AskAIModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            KinicAuroraOrb(size: 72, isActive: model.isGenerating)

            VStack(alignment: .leading, spacing: 10) {
                if model.currentConversation == nil {
                    Text("Select a database")
                        .font(.system(.largeTitle, weight: .bold))
                    Text("Choose a database with Select DB above to start chatting.")
                        .font(.body)
                        .foregroundStyle(KinicDesign.bodyGray)
                } else {
                    Text("Ask your memory")
                        .font(.system(.largeTitle, weight: .bold))
                        .foregroundStyle(KinicDesign.auroraGradient)
                    Text("Kinic AI can chat normally and searches **\(model.databaseTitle)** when your question needs supporting notes.")
                        .font(.body)
                        .foregroundStyle(KinicDesign.bodyGray)
                }
            }

            if model.currentConversation != nil {
                VStack(alignment: .leading, spacing: 10) {
                    Text("TRY ASKING")
                        .font(.caption.weight(.semibold))
                        .tracking(1.6)
                        .foregroundStyle(KinicDesign.bodyGray)
                    AskAIPromptSuggestion(title: "Summarize the main ideas in this database", systemImage: "text.badge.star", model: model)
                    AskAIPromptSuggestion(title: "What decisions have been recorded recently?", systemImage: "clock.badge.checkmark", model: model)
                    AskAIPromptSuggestion(title: "Find notes that disagree with each other", systemImage: "arrow.triangle.branch", model: model)
                }
            }
        }
        .frame(maxWidth: 620, alignment: .leading)
        .padding(.vertical, 32)
        .opacity(appeared ? 1 : 0)
        .offset(y: appeared || reduceMotion ? 0 : 12)
        .onAppear {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.6, dampingFraction: 0.85)) {
                appeared = true
            }
        }
    }
}
