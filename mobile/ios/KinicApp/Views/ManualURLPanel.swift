// Where: mobile/ios/KinicApp/Views/ManualURLPanel.swift
// What: Paste-and-submit URL entry for native source capture.
// Why: Manual captures should use the same queue and auto-submit path as Share Extension captures.

import SwiftUI

struct ManualURLPanel: View {
    @Bindable var model: AppModel
    let isURLFocused: FocusState<Bool>.Binding
    var onSubmitted: () -> Void = {}
    var onInputChanged: (Bool) -> Void = { _ in }
    @State private var urlText = ""

    var body: some View {
        KinicPanel(title: "Save URL", systemImage: "link") {
            VStack(alignment: .leading, spacing: 12) {
                Label(model.selectedDatabase?.displayTitle ?? "No database selected", systemImage: "externaldrive")
                    .font(.subheadline)
                Text("Adds the source to this database and generates Wiki content.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let message = model.statusMessage { StatusPanel(message: message) }
                HStack(alignment: .bottom, spacing: 10) {
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
                        .buttonStyle(KinicIconButtonStyle(.primary))
                        .accessibilityLabel("Send")
                        .disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSubmitting || model.selectedDatabase?.canWrite != true)
                }
            }
        }
        .onChange(of: urlText) { onInputChanged(!urlText.isEmpty) }
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
