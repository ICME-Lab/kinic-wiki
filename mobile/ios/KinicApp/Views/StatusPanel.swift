// Where: mobile/ios/KinicApp/Views/StatusPanel.swift
// What: Latest workflow status message.
// Why: Submission and auth failures need a clear location without interrupting the flow.

import SwiftUI

struct StatusPanel: View {
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(KinicDesign.hotPink)
                .accessibilityHidden(true)

            Text(message)
                .font(.body)
                .foregroundStyle(KinicDesign.bodyGray)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white)
        .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))
        .overlay {
            RoundedRectangle(cornerRadius: KinicDesign.radius)
                .stroke(KinicDesign.hairlineGray)
        }
    }
}

#Preview {
    StatusPanel(message: "Submitted /Sources/source-capture-requests/example.md.")
        .padding()
}
