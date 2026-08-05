// Where: mobile/ios/KinicApp/Views/AskAIMessageView.swift
// What: Full-width user or assistant turn with compact generation status and citations.
// Why: Answers should read conversationally while database evidence stays easy to inspect.

import SwiftUI
import Textual

struct AskAIMessageView: View {
    let message: AskAIMessage
    let openSource: (AskAISource) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            speakerLabel

            if message.role == .user {
                Text(message.text)
                    .font(.body)
                    .textSelection(.enabled)
            } else {
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
                        .foregroundStyle(.secondary)
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
            }
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.vertical, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(message.role == .user ? KinicDesign.panelBackground : KinicDesign.appBackground)
    }

    private var shouldShowTrace: Bool {
        guard !message.trace.isEmpty else { return false }
        return message.state == .generating
            || message.trace.contains(where: { $0.stage == .found })
    }

    private var speakerLabel: some View {
        Label {
            Text(message.role == .user ? "You" : "Kinic AI")
                .font(.headline)
                .bold()
        } icon: {
            if message.role == .user {
                Image(systemName: "person.crop.circle.fill")
            } else {
                Image("KinicMark")
                    .resizable()
                    .scaledToFit()
            }
        }
        .labelStyle(AskAISpeakerLabelStyle())
    }
}

private struct AskAISpeakerLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.icon
                .frame(width: 24, height: 24)
                .foregroundStyle(KinicDesign.hotPink)
            configuration.title
        }
    }
}
