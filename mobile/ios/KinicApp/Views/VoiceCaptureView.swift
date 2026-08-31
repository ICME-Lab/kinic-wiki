// Where: mobile/ios/KinicApp/Views/VoiceCaptureView.swift
// What: Foreground dictation, review, and explicit Kinic save flow.
// Why: Widget and Shortcut launches need one loss-resistant capture surface.

import SwiftUI
import UIKit

struct VoiceCaptureView: View {
    @Bindable var model: AppModel
    let request: VoiceCaptureRequest

    var body: some View {
        if let store = model.voiceCaptureStore {
            VoiceCaptureSessionView(model: model, request: request, store: store)
        } else {
            ContentUnavailableView(
                "Voice Capture Unavailable",
                systemImage: "mic.slash",
                description: Text("On-device voice draft storage could not be opened.")
            )
        }
    }
}

private struct VoiceCaptureSessionView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @Bindable var model: AppModel
    let request: VoiceCaptureRequest
    @State private var coordinator: VoiceCaptureCoordinator
    @State private var savedPath: String?
    @State private var savedDatabaseId: String?

    init(model: AppModel, request: VoiceCaptureRequest, store: VoiceCaptureStore) {
        self.model = model
        self.request = request
        _coordinator = State(initialValue: VoiceCaptureCoordinator(store: store))
    }

    var body: some View {
        NavigationStack {
            ZStack {
                KinicDesign.appBackground
                    .ignoresSafeArea()

                ScrollView {
                    VStack(spacing: 20) {
                        phaseContent
                    }
                    .padding(KinicDesign.screenPadding)
                }
            }
            .navigationTitle(request.mode.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark", action: close)
                        .labelStyle(.iconOnly)
                        .disabled(coordinator.phase == .saving)
                }
            }
        }
        .interactiveDismissDisabled(coordinator.phase == .recording || coordinator.phase == .saving)
        .task(id: request.id) {
            await coordinator.start(
                mode: request.mode,
                language: model.wikiOutputLanguage,
                scope: model.voiceCaptureScope,
                databaseId: defaultDatabaseId
            )
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background, coordinator.phase == .requestingPermission {
                coordinator.preserveForDismissal()
            } else if phase != .active,
               request.mode == .dictation,
               coordinator.phase == .recording {
                coordinator.preserveForDismissal()
            }
        }
        .onDisappear {
            coordinator.preserveForDismissal()
        }
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch coordinator.phase {
        case .idle:
            if let savedPath, let savedDatabaseId {
                savedContent(path: savedPath, databaseId: savedDatabaseId)
            } else {
                ProgressView()
            }
        case .requestingPermission:
            VStack(spacing: 12) {
                ProgressView()
                Text("Preparing on-device speech recognition…")
                    .foregroundStyle(.secondary)
            }
        case .recording:
            recordingContent
        case .reviewing, .saving:
            reviewContent
        case .failed:
            failureContent
        }
    }

    private var recordingContent: some View {
        VStack(spacing: 20) {
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(KinicDesign.hotPink)
                .symbolEffect(.pulse)
                .accessibilityHidden(true)

            Text(durationLabel)
                .font(.title2.monospacedDigit().weight(.semibold))

            Text(recordingPrivacyLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)

            Group {
                if let transcript = coordinator.draft?.transcript, !transcript.isEmpty {
                    Text(transcript)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                } else {
                    Text("Start speaking…")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
            .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
            .background(.background, in: RoundedRectangle(cornerRadius: 16))

            Button("Stop and Review", systemImage: "stop.fill") {
                coordinator.stop()
            }
            .buttonStyle(KinicPrimaryButtonStyle())
        }
    }

    private var reviewContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField("Title", text: titleBinding)
                .textFieldStyle(.roundedBorder)

            Picker("Database", selection: databaseBinding) {
                Text("Select a database").tag("")
                ForEach(model.voiceCaptureDatabaseCandidates) { database in
                    Text(database.displayTitle).tag(database.databaseId)
                }
            }

            Text("Transcript")
                .font(.headline)
            TextEditor(text: transcriptBinding)
                .frame(minHeight: 220)
                .padding(8)
                .background(.background, in: RoundedRectangle(cornerRadius: 12))
                .disabled(coordinator.isTranscribing)

            Text(reviewPrivacyLabel)
                .font(.footnote)
                .foregroundStyle(.secondary)

            if coordinator.isTranscribing {
                HStack {
                    ProgressView()
                    Text("Transcribing on this device…")
                }
                .font(.footnote)
            }

            if let message = coordinator.errorMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }

            Button("Save to Kinic", systemImage: "square.and.arrow.down", action: save)
                .buttonStyle(KinicPrimaryButtonStyle())
                .disabled(!canSave || coordinator.phase == .saving || coordinator.isTranscribing)

            Button("Discard Draft", role: .destructive) {
                coordinator.discard()
                close()
            }
            .frame(maxWidth: .infinity)
            .disabled(coordinator.phase == .saving)
        }
    }

    private var failureContent: some View {
        VStack(spacing: 16) {
            ContentUnavailableView(
                "Voice Capture Stopped",
                systemImage: "mic.slash",
                description: Text(coordinator.errorMessage ?? "Voice capture could not start.")
            )
            Button("Open Settings", systemImage: "gear") {
                guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                UIApplication.shared.open(url)
            }
            Button("Try Again") {
                coordinator.discard()
                Task {
                    await coordinator.start(
                        mode: request.mode,
                        language: model.wikiOutputLanguage,
                        scope: model.voiceCaptureScope,
                        databaseId: defaultDatabaseId
                    )
                }
            }
            .buttonStyle(KinicPrimaryButtonStyle())
        }
    }

    private func savedContent(path: String, databaseId: String) -> some View {
        VStack(spacing: 16) {
            ContentUnavailableView(
                "Voice Note Saved",
                systemImage: "checkmark.circle.fill",
                description: Text(path)
            )
            Button("Open in Browse", systemImage: "doc.text") {
                model.openVoiceCaptureDocument(databaseId: databaseId, path: path)
                dismiss()
            }
            .buttonStyle(KinicPrimaryButtonStyle())
            Button("Done", action: close)
        }
    }

    private var titleBinding: Binding<String> {
        Binding(
            get: { coordinator.draft?.title ?? "" },
            set: { value in updateReview(title: value) }
        )
    }

    private var transcriptBinding: Binding<String> {
        Binding(
            get: { coordinator.draft?.transcript ?? "" },
            set: { value in updateReview(transcript: value) }
        )
    }

    private var databaseBinding: Binding<String> {
        Binding(
            get: { coordinator.draft?.databaseId ?? "" },
            set: { value in updateReview(databaseId: value.isEmpty ? nil : value) }
        )
    }

    private var defaultDatabaseId: String? {
        let selected = model.selectedDatabaseId.trimmingCharacters(in: .whitespacesAndNewlines)
        return model.voiceCaptureDatabaseCandidates.contains(where: { $0.databaseId == selected }) ? selected : nil
    }

    private var canSave: Bool {
        guard model.isSignedIn, !coordinator.isTranscribing, let draft = coordinator.draft else { return false }
        return !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && draft.databaseId?.isEmpty == false
    }

    private var recordingPrivacyLabel: String {
        if request.mode == .voiceMemo {
            return "Recording locally · \(model.wikiOutputLanguage.displayName)"
        }
        return "On-device only · \(model.wikiOutputLanguage.displayName)"
    }

    private var reviewPrivacyLabel: String {
        if request.mode == .voiceMemo {
            return "Saves only the transcript to \(VoiceCaptureDocument.directoryPath). Audio stays on this device."
        }
        return "Saves to \(VoiceCaptureDocument.directoryPath). Audio is not retained."
    }

    private var durationLabel: String {
        let seconds = coordinator.elapsedSeconds
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }

    private func updateReview(title: String? = nil, transcript: String? = nil, databaseId: String?? = nil) {
        guard let draft = coordinator.draft else { return }
        coordinator.updateReview(
            title: title ?? draft.title,
            transcript: transcript ?? draft.transcript,
            databaseId: databaseId ?? draft.databaseId
        )
    }

    private func save() {
        guard coordinator.beginSaving(), let draft = coordinator.draft, let databaseId = draft.databaseId else { return }
        Task {
            do {
                let path = try await model.saveVoiceCaptureDraft(
                    draft,
                    title: draft.title,
                    transcript: draft.transcript,
                    databaseId: databaseId
                )
                try coordinator.finishSaving(savedPath: path)
                savedPath = path
                savedDatabaseId = databaseId
            } catch {
                coordinator.savingFailed(error)
            }
        }
    }

    private func close() {
        coordinator.preserveForDismissal()
        model.dismissVoiceCapture()
        dismiss()
    }
}
