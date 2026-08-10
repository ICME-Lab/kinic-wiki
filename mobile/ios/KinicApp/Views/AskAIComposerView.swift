// Where: mobile/ios/KinicApp/Views/AskAIComposerView.swift
// What: Multiline conversational composer.
// Why: Keep message entry and generation controls compact and accessible.

import SwiftUI

struct AskAIComposerView: View {
    @Bindable var model: AskAIModel

    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Message Kinic AI", text: $model.draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.plain)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)

                if model.isGenerating {
                    Button("Stop generating", systemImage: "stop.circle.fill", action: model.cancelGeneration)
                        .labelStyle(.iconOnly)
                        .font(.title2)
                        .foregroundStyle(KinicDesign.hotPink)
                        .frame(minWidth: 44, minHeight: 44)
                } else {
                    Button("Send", systemImage: "arrow.up.circle.fill", action: model.send)
                        .labelStyle(.iconOnly)
                        .font(.title2)
                        .foregroundStyle(model.canSend ? KinicDesign.hotPink : .secondary)
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(!model.canSend)
                }
            }
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: KinicDesign.largeRadius))

            Text(
                "\(model.draft.count) / \(AskAIModel.maximumQuestionCharacters) characters"
            )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .accessibilityLabel(
                    "\(model.remainingQuestionCharacters) characters remaining"
                )
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }
}
