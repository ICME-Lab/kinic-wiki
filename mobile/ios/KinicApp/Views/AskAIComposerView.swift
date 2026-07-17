// Where: mobile/ios/KinicApp/Views/AskAIComposerView.swift
// What: Multiline grounded-question composer and privacy notice.
// Why: Sending scope must remain clear at the moment DB text leaves the device.

import SwiftUI

struct AskAIComposerView: View {
    @Bindable var model: AskAIModel

    var body: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask about this database", text: $model.draft, axis: .vertical)
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

            Label(
                "Your question and relevant notes are sent to Kinic AI.",
                systemImage: "lock.shield"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }
}
