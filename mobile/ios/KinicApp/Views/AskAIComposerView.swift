// Where: mobile/ios/KinicApp/Views/AskAIComposerView.swift
// What: Multiline conversational composer and privacy notice.
// Why: Sending scope must remain clear when chat or selected note text leaves the device.

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

            Label(
                "Your message and recent conversation are sent to Kinic AI. Relevant notes are included only when a database search is needed, then deleted after processing.",
                systemImage: "lock.shield"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }
}
