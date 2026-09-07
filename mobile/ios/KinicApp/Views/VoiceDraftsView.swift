// Where: mobile/ios/KinicApp/Views/VoiceDraftsView.swift
// What: Settings list for reviewing, retrying, and deleting local voice drafts.
// Why: Failed or signed-out captures must never auto-upload or become inaccessible.

import SwiftUI

struct VoiceDraftsView: View {
    @Bindable var model: AppModel
    @State private var drafts: [VoiceCaptureDraft] = []
    @State private var selectedDraft: VoiceCaptureDraft?
    @State private var errorMessage: String?
    @State private var showsRemoveAllConfirmation = false

    var body: some View {
        List {
            if drafts.isEmpty {
                ContentUnavailableView(
                    "No Voice Drafts",
                    systemImage: "waveform",
                    description: Text("Interrupted or unsynced voice notes appear here.")
                )
            } else {
                ForEach(drafts) { draft in
                    Button {
                        selectedDraft = draft
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(draft.title)
                                .font(.headline)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(draft.transcript.isEmpty ? "No transcript" : draft.transcript)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                            Text(draft.scope == .guest ? "Guest draft" : "Signed-in draft")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) {
                            remove(draft)
                        }
                    }
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
            }
        }
        .navigationTitle("Voice Drafts")
        .toolbar {
            if !drafts.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Delete All", role: .destructive) {
                        showsRemoveAllConfirmation = true
                    }
                }
            }
        }
        .task {
            reload()
        }
        .sheet(item: $selectedDraft) { draft in
            VoiceDraftReviewView(model: model, draft: draft) {
                selectedDraft = nil
                reload()
            }
        }
        .confirmationDialog(
            "Delete all visible voice drafts?",
            isPresented: $showsRemoveAllConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete All", role: .destructive, action: removeAll)
        }
    }

    private func reload() {
        drafts = model.voiceCaptureDrafts()
    }

    private func remove(_ draft: VoiceCaptureDraft) {
        do {
            try model.removeVoiceCaptureDraft(draft)
            reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func removeAll() {
        do {
            try model.removeAllVisibleVoiceCaptureDrafts()
            reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct VoiceDraftReviewView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: AppModel
    let draft: VoiceCaptureDraft
    let onSaved: () -> Void
    @State private var title: String
    @State private var transcript: String
    @State private var databaseId: String
    @State private var isSaving = false
    @State private var errorMessage: String?

    init(model: AppModel, draft: VoiceCaptureDraft, onSaved: @escaping () -> Void) {
        self.model = model
        self.draft = draft
        self.onSaved = onSaved
        _title = State(initialValue: draft.title)
        _transcript = State(initialValue: draft.transcript)
        _databaseId = State(initialValue: draft.databaseId ?? model.selectedDatabaseId)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Voice Note") {
                    TextField("Title", text: $title)
                    TextEditor(text: $transcript)
                        .frame(minHeight: 180)
                }
                Section("Destination") {
                    Picker("Database", selection: $databaseId) {
                        Text("Select a database").tag("")
                        ForEach(model.voiceCaptureDatabaseCandidates) { database in
                            Text(database.displayTitle).tag(database.databaseId)
                        }
                    }
                    Text(VoiceCaptureDocument.directoryPath)
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Review Draft")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(!canSave || isSaving)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
    }

    private var canSave: Bool {
        model.isSignedIn
            && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !databaseId.isEmpty
    }

    private func save() {
        guard canSave, !isSaving else { return }
        isSaving = true
        errorMessage = nil
        Task {
            do {
                _ = try await model.saveVoiceCaptureDraft(
                    draft,
                    title: title,
                    transcript: transcript,
                    databaseId: databaseId
                )
                try model.removeVoiceCaptureDraft(draft)
                onSaved()
                dismiss()
            } catch {
                isSaving = false
                errorMessage = error.localizedDescription
            }
        }
    }
}
