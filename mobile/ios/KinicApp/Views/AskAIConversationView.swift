// Where: mobile/ios/KinicApp/Views/AskAIConversationView.swift
// What: Full-width chronological Ask AI document surface.
// Why: Markdown, retrieval traces, and evidence need more room than chat bubbles provide.

import SwiftUI

struct AskAIConversationView: View {
    @Bindable var model: AskAIModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.messages.isEmpty {
                        AskAIEmptyConversationView(model: model)
                            .padding(KinicDesign.screenPadding)
                    } else {
                        ForEach(model.messages) { message in
                            AskAIMessageView(message: message, openSource: model.openSource)
                                .id(message.id)
                        }
                    }
                }
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.messages.last?.text) {
                guard let id = model.messages.last?.id else { return }
                if reduceMotion {
                    proxy.scrollTo(id, anchor: .bottom)
                } else {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
        }
        .overlay(alignment: .top) {
            if case let .failed(message) = model.loadState {
                AskAIHistoryRecoveryView(model: model, message: message)
                    .padding(.horizontal, KinicDesign.screenPadding)
                    .padding(.top, 8)
            } else if let error = model.errorMessage {
                AskAIErrorBanner(message: error) {
                    model.errorMessage = nil
                }
                .padding(.horizontal, KinicDesign.screenPadding)
                .padding(.top, 8)
            }
        }
    }
}
