// Where: mobile/ios/KinicApp/Views/AskAITraceView.swift
// What: Compact active status or a collapsible completed database-search trace.
// Why: Progress stays unobtrusive while completed retrieval counts remain inspectable.

import SwiftUI

struct AskAITraceView: View {
    @State private var isExpanded = false
    let events: [AskAITraceEvent]

    @ViewBuilder
    var body: some View {
        if hasActiveEvent {
            activeStatus
        } else {
            completedTrace
        }
    }

    private var activeStatus: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkle.magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(KinicDesign.hotPink)
                .symbolEffect(.pulse, options: .repeating)
            Text(summary)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(KinicDesign.bodyGray)
                .kinicShimmer()
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.3), value: summary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(summary)
    }

    private var completedTrace: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(events.enumerated()), id: \.element.id) { index, event in
                    AskAITraceEventView(event: event, showsLine: index < events.count - 1)
                }
            }
            .padding(.top, 12)
        } label: {
            Label("How this answer was found", systemImage: "sparkles")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(KinicDesign.hotPink)
        }
        .tint(.secondary)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .kinicCard(radius: 18)
        .accessibilityHint("Shows search queries, candidate counts, and verified notes")
    }

    private var hasActiveEvent: Bool {
        events.contains(where: \.isActive)
    }

    private var summary: String {
        if let active = events.last(where: \.isActive) {
            return active.title
        }
        return "Preparing a response"
    }
}
