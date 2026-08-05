// Where: mobile/ios/KinicApp/Views/AskAISourcesView.swift
// What: Compact, wrapping citation links attached to a database-backed answer.
// Why: Sources should remain inspectable without competing with the answer.

import SwiftUI

struct AskAISourcesView: View {
    let heading: String
    let sources: [AskAISource]
    let openSource: (AskAISource) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(heading)
                .font(.caption)
                .foregroundStyle(.secondary)

            AskAISourceFlowLayout(spacing: 6) {
                ForEach(Array(sources.enumerated()), id: \.element.id) { index, source in
                    Button {
                        openSource(source)
                    } label: {
                        Text("[\(index + 1)] \(source.displayName)")
                            .font(.footnote)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 44)
                            .background(KinicDesign.palePink.opacity(0.28))
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(KinicDesign.electricIndigo)
                    .accessibilityLabel("Source \(index + 1), \(source.displayName)")
                    .accessibilityHint("Opens this note in Browse")
                }
            }
        }
    }
}

private struct AskAISourceFlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let result = layout(subviews: subviews, width: proposal.width ?? .infinity)
        return CGSize(width: proposal.width ?? result.width, height: result.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = measuredSize(for: subview, maximumWidth: bounds.width)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(
                at: CGPoint(x: x, y: y),
                anchor: .topLeading,
                proposal: ProposedViewSize(size)
            )
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }

    private func layout(subviews: Subviews, width: CGFloat) -> (width: CGFloat, height: CGFloat) {
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var contentWidth: CGFloat = 0

        for subview in subviews {
            let size = measuredSize(
                for: subview,
                maximumWidth: width.isFinite ? width : nil
            )
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            contentWidth = max(contentWidth, x + size.width)
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return (contentWidth, y + rowHeight)
    }

    private func measuredSize(
        for subview: LayoutSubview,
        maximumWidth: CGFloat?
    ) -> CGSize {
        let idealSize = subview.sizeThatFits(.unspecified)
        guard let maximumWidth,
              idealSize.width > maximumWidth else {
            return idealSize
        }
        return subview.sizeThatFits(
            ProposedViewSize(width: maximumWidth, height: nil)
        )
    }
}
