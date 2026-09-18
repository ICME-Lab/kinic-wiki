// Where: mobile/ios/KinicApp/Views/WorkItemComposerView.swift
// What: Text-first composer that stores the input before it is shared.
// Why: An unavailable network must not lose what the member already wrote.

import SwiftUI

struct WorkItemComposerView: View {
    @Bindable var appModel: AppModel
    @Bindable var model: WorkItemModel
    /// Prefill from Browse, Ask AI, or a widget link. `nil` for a plain new item.
    let draft: WorkItemComposeRequest?

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var text = ""
    @State private var hasAppliedDraft = false
    @State private var isSaving = false
    @FocusState private var isTitleFocused: Bool
    @FocusState private var isBodyFocused: Bool

    private var trimmedText: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                KinicDesign.appBackground
                    .ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        destinationPanel
                        titleField

                        TextEditor(text: $text)
                            .focused($isBodyFocused)
                            .frame(minHeight: 200)
                            .padding(12)
                            .scrollContentBackground(.hidden)
                            .background(KinicDesign.controlBackground, in: RoundedRectangle(cornerRadius: KinicDesign.radius))
                            .overlay {
                                RoundedRectangle(cornerRadius: KinicDesign.radius)
                                    .stroke(KinicDesign.hairlineGray, lineWidth: 1)
                            }
                            .accessibilityLabel("Work item body")

                        if draft?.isBodyTruncated == true {
                            Text("Only the first \(WorkItemComposeRequest.bodyCharacterLimit) characters of the source were copied. Edit before saving.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }

                        if let message = model.actionError {
                            StatusPanel(message: message)
                        }
                    }
                    .padding(KinicDesign.screenPadding)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle(draft == nil ? "New item" : "New item from source")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .tint(KinicDesign.hotPink)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", systemImage: "tray.and.arrow.down") {
                        save()
                    }
                    .labelStyle(.titleAndIcon)
                    .tint(KinicDesign.hotPink)
                    .disabled(trimmedText.isEmpty || isSaving || !model.canWrite)
                }
            }
            .onAppear(perform: applyDraftIfNeeded)
        }
        .presentationDetents([.large])
    }

    @ViewBuilder
    private var destinationPanel: some View {
        KinicPanel(title: "Destination", systemImage: "externaldrive") {
            VStack(alignment: .leading, spacing: 6) {
                Text(appModel.selectedDatabase?.displayTitle ?? "No database selected")
                    .font(.body.weight(.semibold))
                Text("Saved on this device first. It is added to the database as soon as the connection allows.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var titleField: some View {
        KinicPanel(title: "Title", systemImage: "textformat") {
            TextField("First line becomes the title", text: $title)
                .textInputAutocapitalization(.sentences)
                .autocorrectionDisabled()
                .focused($isTitleFocused)
                .accessibilityLabel("Work item title")
        }
    }

    /// The draft is applied once so a returning view does not discard what the member typed.
    private func applyDraftIfNeeded() {
        if let draft, !hasAppliedDraft {
            hasAppliedDraft = true
            title = draft.title ?? ""
            text = draft.body
        }
        if trimmedText.isEmpty && title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            isTitleFocused = true
        } else {
            isBodyFocused = true
        }
    }

    private func save() {
        guard !trimmedText.isEmpty else { return }
        isSaving = true
        Task {
            let didSave = await model.create(title: title, body: text, source: draft?.source)
            isSaving = false
            if didSave {
                dismiss()
            }
        }
    }
}
