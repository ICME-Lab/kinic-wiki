// Where: mobile/ios/KinicApp/Views/AskAIHistoryRecoveryView.swift
// What: Explicit retry and destructive-reset controls for unreadable local history.
// Why: A load failure must be resolved before Ask AI can safely persist new conversations.

import SwiftUI

struct AskAIHistoryRecoveryView: View {
    @Bindable var model: AskAIModel
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Conversation history unavailable", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.red)
            Text(message)
                .font(.subheadline)
            HStack(spacing: 12) {
                Button("Retry", systemImage: "arrow.clockwise", action: retry)
                    .frame(minHeight: 44)
                Button("Reset local history", systemImage: "trash", role: .destructive) {
                    model.isConfirmingHistoryReset = true
                }
                .frame(minHeight: 44)
            }
        }
        .padding(12)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
        .accessibilityElement(children: .contain)
    }

    private func retry() {
        Task {
            await model.retryHistoryLoad()
        }
    }
}
