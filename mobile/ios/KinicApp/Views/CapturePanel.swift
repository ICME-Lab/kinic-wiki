// Where: mobile/ios/KinicApp/Views/CapturePanel.swift
// What: Pending Share Extension URL queue and submit action.
// Why: Capture is the app's primary workflow, so the queue needs a prominent native surface.

import SwiftUI

struct CapturePanel: View {
    @Bindable var model: AppModel

    var body: some View {
        KinicPanel(title: "Shared URLs", systemImage: "square.and.arrow.down") {
            VStack(alignment: .leading, spacing: 14) {
                if model.pendingURLs.isEmpty {
                    ContentUnavailableView(
                        "No shared URLs",
                        systemImage: "square.and.arrow.up",
                        description: Text("Use the iOS share sheet from Safari or another browser.")
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(model.pendingURLs) { item in
                            PendingURLRow(item: item)
                        }
                    }
                }

                Button(model.isSubmitting ? "Submitting next URL" : "Submit next URL", systemImage: "paperplane.fill", action: model.startSubmitNextPendingURL)
                    .buttonStyle(KinicPrimaryButtonStyle())
                    .disabled(!model.canSubmit)

                Button("Refresh inbox", systemImage: "arrow.clockwise", action: model.refreshInbox)
                    .buttonStyle(KinicSecondaryButtonStyle())
            }
        }
    }
}

#Preview {
    CapturePanel(model: .preview())
        .padding()
}
