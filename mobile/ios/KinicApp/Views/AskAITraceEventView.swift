// Where: mobile/ios/KinicApp/Views/AskAITraceEventView.swift
// What: One node and connector in the memory retrieval timeline.
// Why: Ordered visual structure makes the real retrieval process quickly scannable.

import SwiftUI

struct AskAITraceEventView: View {
    let event: AskAITraceEvent
    let showsLine: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                if event.isActive {
                    ProgressView()
                        .controlSize(.small)
                        .tint(KinicDesign.hotPink)
                        .frame(width: 18, height: 18)
                } else {
                    Circle()
                        .fill(KinicDesign.hotPink)
                        .frame(width: 10, height: 10)
                        .frame(width: 18, height: 18)
                }
                if showsLine {
                    Rectangle()
                        .fill(KinicDesign.hotPink.opacity(0.35))
                        .frame(width: 2, height: 36)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(event.title)
                    .font(.subheadline)
                if let detail = event.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
            }
            .padding(.bottom, showsLine ? 8 : 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(event.isActive ? "In progress" : "Complete")
    }
}
