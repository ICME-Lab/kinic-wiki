// Where: mobile/ios/KinicApp/Views/ManualURLPanel.swift
// What: Paste-and-submit URL entry for native source capture.
// Why: Manual captures should use the same queue and auto-submit path as Share Extension captures.

import SwiftUI

struct ManualURLPanel: View {
    @Bindable var model: AppModel
    let isURLFocused: FocusState<Bool>.Binding
    var onSubmitted: () -> Void = {}
    @State private var urlText = ""

    var body: some View {
        KinicPanel(title: "Ingest", systemImage: "link") {
            VStack(alignment: .leading, spacing: 12) {
                TextField(
                    "",
                    text: $urlText,
                    prompt: Text("https://example.com/article")
                        .foregroundStyle(.secondary),
                    axis: .vertical
                )
                    .foregroundStyle(.primary)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .focused(isURLFocused)
                    .lineLimit(1...3)
                    .accessibilityLabel("URL")
                    .padding(14)
                    .background(KinicDesign.controlBackground)
                    .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))

                Button("Send", systemImage: "paperplane.fill", action: submitURL)
                    .labelStyle(.iconOnly)
                    .buttonStyle(KinicPrimaryButtonStyle())
                    .accessibilityLabel("Send")
                    .disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSubmitting)
            }
        }
    }

    private func submitURL() {
        if model.enqueueManualURL(urlText) {
            urlText = ""
            onSubmitted()
        }
    }
}

#Preview {
    @Previewable @FocusState var isURLFocused: Bool

    ManualURLPanel(model: .preview(), isURLFocused: $isURLFocused)
        .padding()
        .background(.white)
}
