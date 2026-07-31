// Where: mobile/ios/KinicApp/Views/AskAIErrorBanner.swift
// What: Dismissible transport or persistence error banner.
// Why: Operational failures must not be misrepresented as missing DB evidence.

import SwiftUI

struct AskAIErrorBanner: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .accessibilityHidden(true)
            Text(message)
                .font(.subheadline)
            Spacer(minLength: 8)
            Button("Dismiss", systemImage: "xmark", action: dismiss)
                .labelStyle(.iconOnly)
                .frame(minWidth: 44, minHeight: 44)
        }
        .padding(12)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
        .accessibilityElement(children: .contain)
    }
}
