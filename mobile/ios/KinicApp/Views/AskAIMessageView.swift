// Where: mobile/ios/KinicApp/Views/AskAIMessageView.swift
// What: Full-width user or assistant turn with compact generation status and citations.
// Why: Answers should read conversationally while database evidence stays easy to inspect.

import SwiftUI
import Textual

struct AskAIMessageView: View {
    let message: AskAIMessage
    let openSource: (AskAISource) -> Void
    /// Hands a finished answer to Home so it can become a work item.
    let createWorkItem: (AskAIMessage) -> Void

    var body: some View {
        if message.role == .user {
            userBubble
        } else {
            assistantTurn
        }
    }

    /// The user's words sit right-aligned in a brand-gradient bubble.
    private var userBubble: some View {
        HStack {
            Spacer(minLength: 56)
            Text(message.text)
                .font(.body)
                .foregroundStyle(.white)
                .textSelection(.enabled)
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .background(KinicDesign.auroraGradient, in: UnevenRoundedRectangle(
                    topLeadingRadius: 22, bottomLeadingRadius: 22, bottomTrailingRadius: 6, topTrailingRadius: 22, style: .continuous))
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.top, 20)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You: \(message.text)")
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private var assistantTurn: some View {
        VStack(alignment: .leading, spacing: 14) {
            speakerLabel

            if shouldShowTrace {
                AskAITraceView(events: message.trace)
            }

            switch message.state {
            case .generating, .complete:
                if !message.text.isEmpty {
                    StructuredText(markdown: message.text)
                        .textual.structuredTextStyle(.gitHub)
                        .textual.textSelection(.enabled)
                        .foregroundStyle(.primary)
                }
            case .insufficient:
                Label(message.text, systemImage: "text.magnifyingglass")
                    .foregroundStyle(KinicDesign.bodyGray)
            case .failed:
                Label(message.text, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
            }

            if !message.sources.isEmpty {
                AskAISourcesView(
                    heading: message.state == .insufficient
                        ? "Possible sources"
                        : "Sources cited by Kinic AI",
                    sources: message.sources,
                    openSource: openSource
                )
            }

            if message.state == .complete, !message.text.isEmpty {
                Button {
                    createWorkItem(message)
                } label: {
                    Label("New item", systemImage: "square.and.pencil")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 36)
                        .foregroundStyle(KinicDesign.hotPink)
                        .background(KinicDesign.hotPink.opacity(0.12), in: Capsule())
                        .frame(minHeight: 44)
                }
                .buttonStyle(KinicPressableStyle())
                .accessibilityHint("Creates a work item from this answer in the selected database")
            }
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity)
    }

    private var shouldShowTrace: Bool {
        guard !message.trace.isEmpty else { return false }
        return message.state == .generating
            || message.trace.contains(where: { $0.stage == .found })
    }

    private var speakerLabel: some View {
        HStack(spacing: 10) {
            KinicAuroraOrb(size: 26, isActive: message.state == .generating)
            Text("Kinic AI")
                .font(.subheadline.weight(.semibold))
            if message.state == .generating {
                Text("Thinking…")
                    .font(.subheadline)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.25), value: message.state == .generating)
        .accessibilityElement(children: .combine)
    }
}
