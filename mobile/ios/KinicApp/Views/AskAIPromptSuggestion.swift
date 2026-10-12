// Where: mobile/ios/KinicApp/Views/AskAIPromptSuggestion.swift
// What: One grounded question starter for an empty Ask AI conversation.
// Why: Suggestions demonstrate the feature boundary while reducing blank-page friction.

import SwiftUI

struct AskAIPromptSuggestion: View {
    let title: String
    var systemImage: String = "sparkles"
    @Bindable var model: AskAIModel

    var body: some View {
        Button {
            model.draft = title
        } label: {
            HStack(spacing: 14) {
                Image(systemName: systemImage)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(KinicDesign.hotPink)
                    .frame(width: 34, height: 34)
                    .background(KinicDesign.hotPink.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .kinicCard(radius: 18)
        }
        .buttonStyle(KinicPressableStyle(scale: 0.98))
        .sensoryFeedback(.selection, trigger: model.draft == title) { _, new in new }
        .accessibilityLabel(title)
        .accessibilityHint("Copies this question into the message field")
    }
}
