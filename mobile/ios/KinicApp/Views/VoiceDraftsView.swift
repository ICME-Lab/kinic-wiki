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
    @State private var workingDraft: VoiceCaptureDraft

    init(model: AppModel, draft: VoiceCaptureDraft, onSaved: @escaping () -> Void) {
        self.model = model
        self.draft = draft
        self.onSaved = onSaved
        _title = State(initialValue: draft.title)
        _transcript = State(initialValue: draft.transcript)
        _databaseId = State(initialValue: draft.databaseId ?? model.selectedDatabaseId)
        _workingDraft = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Voice Note") {
                    TextField("Title", text: $title)
                    TextEditor(text: $transcript)
                        .frame(minHeight: 180)
                }
                if workingDraft.mode == .voiceMemo {
                    VoiceMemoAudioControls(
                        model: model,
                        draft: $workingDraft,
                        transcript: $transcript,
                        errorMessage: $errorMessage
                    )
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
                    Button("Done") {
                        persistLocalEdits()
                        dismiss()
                    }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(!canSave || isSaving)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
        .onDisappear {
            persistLocalEdits()
        }
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
                    workingDraft,
                    title: title,
                    transcript: transcript,
                    databaseId: databaseId
                )
                if workingDraft.mode == .voiceMemo {
                    workingDraft.title = title
                    workingDraft.transcript = transcript
                    workingDraft.databaseId = databaseId
                    workingDraft.kinicPath = try VoiceCaptureDocument.make(
                        from: workingDraft,
                        title: title,
                        transcript: transcript
                    ).path
                    try model.persistVoiceCaptureDraft(workingDraft)
                } else {
                    try model.removeVoiceCaptureDraft(workingDraft)
                }
                onSaved()
                dismiss()
            } catch {
                isSaving = false
                errorMessage = error.localizedDescription
            }
        }
    }

    private func persistLocalEdits() {
        workingDraft.title = title
        workingDraft.transcript = transcript
        workingDraft.databaseId = databaseId.isEmpty ? nil : databaseId
        do {
            try model.persistVoiceCaptureDraft(workingDraft)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct VoiceMemoAudioControls: View {
    @Bindable var model: AppModel
    @Binding var draft: VoiceCaptureDraft
    @Binding var transcript: String
    @Binding var errorMessage: String?
    @State private var player = VoiceMemoPlayer()
    @State private var transcriber = VoiceMemoEngine()
    @State private var isTranscribing = false
    @State private var showsDeleteAudioConfirmation = false

    var body: some View {
        Section("Device-local Audio") {
            if let audioURL = model.voiceCaptureAudioURL(for: draft) {
                HStack {
                    Button {
                        player.togglePlayback()
                    } label: {
                        Label(player.isPlaying ? "Pause" : "Play", systemImage: player.isPlaying ? "pause.fill" : "play.fill")
                    }
                    Slider(value: progressBinding, in: 0 ... max(player.duration, 0.1))
                }
                Text("Audio stays on this device and is never included in the Kinic upload.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Button("Retry On-device Transcription", systemImage: "text.badge.plus") {
                    retryTranscription(audioURL: audioURL)
                }
                .disabled(isTranscribing)
                Button("Delete Audio Only", role: .destructive) {
                    showsDeleteAudioConfirmation = true
                }
            } else {
                Text("The local audio has been deleted. The transcript is still available.")
                    .foregroundStyle(.secondary)
            }
        }
        .task(id: draft.audioFilename) {
            player.stop()
            if let url = model.voiceCaptureAudioURL(for: draft) {
                try? player.load(url: url)
            }
        }
        .onDisappear {
            player.stop()
            transcriber.cancelRecording(deleteFile: false)
        }
        .confirmationDialog(
            "Delete the local audio and keep the transcript?",
            isPresented: $showsDeleteAudioConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete Audio", role: .destructive, action: deleteAudio)
        }
    }

    private var progressBinding: Binding<Double> {
        Binding(
            get: { player.currentTime },
            set: { player.seek(to: $0) }
        )
    }

    private func retryTranscription(audioURL: URL) {
        guard !isTranscribing else { return }
        isTranscribing = true
        errorMessage = nil
        transcriber.transcribe(
            url: audioURL,
            locale: Locale(identifier: draft.language.rawValue),
            onTranscript: { value in
                transcript = value
            },
            onCompletion: { result in
                isTranscribing = false
                switch result {
                case let .success(value):
                    transcript = value
                    draft.transcript = value
                    try? model.persistVoiceCaptureDraft(draft)
                case let .failure(error):
                    errorMessage = VoiceCaptureError.transcriptionFailed(error.localizedDescription).localizedDescription
                }
            }
        )
    }

    private func deleteAudio() {
        do {
            player.stop()
            draft = try model.removeVoiceCaptureAudio(from: draft)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
