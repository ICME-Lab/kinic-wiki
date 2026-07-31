// Where: mobile/ios/KinicApp/Views/AskAITraceView.swift
// What: Collapsible Kinic memory-retrieval timeline.
// Why: Users can inspect real search work without exposing or fabricating private model reasoning.

import SwiftUI

struct AskAITraceView: View {
    @State private var isExpanded = false
    let events: [AskAITraceEvent]

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    AskAITraceEventView(event: event, showsLine: index < events.count - 1)
                }
            }
            .padding(.top, 12)
        } label: {
            Label(summary, systemImage: "sparkles")
                .font(.subheadline)
                .bold()
                .foregroundStyle(KinicDesign.electricIndigo)
        }
        .padding(16)
        .background(KinicDesign.palePink.opacity(0.35))
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
        .accessibilityHint("Shows the database search and evidence checks")
    }

    private var summary: String {
        if let active = events.last(where: \.isActive) {
            return active.title
        }
        return "How this answer was found"
    }
}
