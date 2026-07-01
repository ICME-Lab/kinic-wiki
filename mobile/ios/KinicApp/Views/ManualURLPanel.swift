// Where: mobile/ios/KinicApp/Views/ManualURLPanel.swift
// What: Paste-and-submit URL entry for native source capture.
// Why: Manual captures should use the same queue and auto-submit path as Share Extension captures.

import SwiftUI

struct ManualURLPanel: View {
    @Bindable var model: AppModel
    let isURLFocused: FocusState<Bool>.Binding
    @State private var urlText = ""

    var body: some View {
        KinicPanel(title: "Send URL", systemImage: "link") {
            VStack(alignment: .leading, spacing: 12) {
                ZStack(alignment: .topLeading) {
                    if urlText.isEmpty {
                        Text("https://example.com/article")
                            .foregroundStyle(KinicDesign.bodyGray)
                            .allowsHitTesting(false)
                    }

                    TextField("", text: $urlText, axis: .vertical)
                        .foregroundStyle(.black)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .focused(isURLFocused)
                        .lineLimit(1...3)
                        .accessibilityLabel("URL")
                }
                    .padding(14)
                    .background(.white)
                    .clipShape(RoundedRectangle(cornerRadius: KinicDesign.radius))

                Button("Send", systemImage: "paperplane.fill", action: submitURL)
                    .buttonStyle(KinicPrimaryButtonStyle())
                    .disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSubmitting)
            }
        }
    }

    private func submitURL() {
        if model.enqueueManualURL(urlText) {
            urlText = ""
        }
    }
}

#Preview {
    @Previewable @FocusState var isURLFocused: Bool

    ManualURLPanel(model: .preview(), isURLFocused: $isURLFocused)
        .padding()
        .background(.white)
}
