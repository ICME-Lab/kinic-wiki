// Where: mobile/ios/KinicApp/Views/AskAIPromptSuggestion.swift
// What: One grounded question starter for an empty Ask AI conversation.
// Why: Suggestions demonstrate the feature boundary while reducing blank-page friction.

import SwiftUI

struct AskAIPromptSuggestion: View {
    let title: String
    @Bindable var model: AskAIModel

    var body: some View {
        Button {
            model.draft = title
        } label: {
            HStack {
                Text(title)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 12)
                Image(systemName: "arrow.up.right")
                    .accessibilityHidden(true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(KinicDesign.panelBackground)
            .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
        }
        .buttonStyle(.plain)
        .accessibilityHint("Copies this question into the message field")
    }
}
