import SwiftUI

struct VoicePreviewView: View {
    @Bindable var appModel: AppModel
    @Bindable var model: VoicePreviewModel
    @Environment(\.dismiss) private var dismiss
    @State private var consent = false
    @State private var changedCitation: AssistantCitation?
    @State private var citationError: String?
    @State private var showPolicy = false
    @State private var selectedDatabaseId: String

    init(appModel: AppModel, model: VoicePreviewModel) {
        self.appModel = appModel
        self.model = model
        _selectedDatabaseId = State(initialValue: appModel.selectedAskAIDatabaseId)
    }

    private var selectedDatabase: DatabaseSummary? {
        appModel.askAIDatabaseCandidates.first { $0.databaseId == selectedDatabaseId }
    }

    private var selectedDatabaseTitle: String {
        selectedDatabase?.displayTitle ?? selectedDatabaseId
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Database") {
                    if model.snapshot == nil {
                        Picker("Database", selection: $selectedDatabaseId) {
                            if appModel.askAIDatabaseCandidates.isEmpty {
                                Text("No readable databases").tag("")
                            } else {
                                ForEach(appModel.askAIDatabaseCandidates) { database in
                                    Text(database.displayTitle).tag(database.databaseId)
                                }
                            }
                        }
                    } else {
                        Text(selectedDatabaseTitle)
                    }
                }
                if model.snapshot == nil {
                    Section("Voice preview") {
                        Text("Your questions, microphone audio, conversation context and relevant Wiki excerpts are sent to OpenAI. Kinic temporarily stores conversation data so the preview can recover from interruptions, separately from your Ask AI history. Kinic does not save voice recordings. OpenAI stores Agent sessions in the US and does not support Zero Data Retention. Ending the conversation deletes Kinic's active conversation copy and requests deletion of the OpenAI session, but provider records and backups may remain for their retention periods.")
                        Toggle("I agree to this processing and storage", isOn: $consent)
                        Picker("Search scope", selection: $model.scope) {
                            Text("Knowledge").tag("/Knowledge")
                            Text("Memory").tag("/Memory")
                        }
                        Button("Connect preview") {
                            let selectedPath = selectedDatabaseId == appModel.selectedAskAIDatabaseId
                                ? appModel.selectedBrowseNodePath
                                : nil
                            Task { await model.connect(databaseId: selectedDatabaseId, principal: appModel.principalText, selectedPath: selectedPath) }
                        }.disabled(!consent || model.busy || !appModel.isSignedIn || selectedDatabaseId.isEmpty)
                    }
                } else {
                    if model.reconnecting { Label("Reconnecting…", systemImage: "network") }
                    if let progress = model.snapshot?.progress { Text("Reading Wiki · \(progress.calls) tool calls") }
                    ForEach(model.snapshot?.messages ?? []) { message in
                        Section {
                            Text(message.question).font(.headline)
                            if let answer = message.answer {
                                Text(answer.answer).textSelection(.enabled)
                                if answer.insufficient { Text("The available evidence is incomplete.").foregroundStyle(.secondary) }
                                ForEach(answer.contradictions + answer.unverified, id: \.self) { Text($0).foregroundStyle(.secondary) }
                                ForEach(answer.citations) { citation in
                                    Button(citation.path) {
                                        Task {
                                            do {
                                                if try await model.citationChanged(citation) { changedCitation = citation }
                                                else { open(citation) }
                                            } catch { citationError = error.localizedDescription }
                                        }
                                    }
                                    Text(citation.excerpt).font(.caption).foregroundStyle(.secondary)
                                }
                            } else if message.error != nil { Text("This question could not be answered.") }
                        }
                    }
                    Section("Question") {
                        TextField("Ask about this Wiki", text: $model.draft, axis: .vertical)
                        Button("Send") { Task { await model.send() } }
                            .disabled(model.busy || model.reconnecting || model.snapshot?.status != "ready")
                        Button("Cancel processing") { Task { await model.cancelQuestion() } }
                            .disabled(model.snapshot?.status != "working")
                    }
                    Section("Voice") {
                        if model.voiceActive {
                            Button(model.muted ? "Unmute microphone" : "Mute microphone") { model.toggleMute() }
                            Button("Stop voice") { model.stopVoice() }
                            Text("Connection time is billed while muted and while the device is locked.").font(.caption)
                        } else {
                            Button("Start voice") { Task { await model.loadQuote() } }.disabled(model.busy || model.reconnecting)
                        }
                    }
                }
                if let error = model.error { Section { Text(error).foregroundStyle(.red) } }
                if let citationError { Section { Text(citationError).foregroundStyle(.red) } }
                if selectedDatabase?.role == .owner {
                    Button("Preview access and budget") { showPolicy = true }
                }
            }
            .task(id: appModel.principalText + "|" + selectedDatabaseId) {
                if appModel.isSignedIn, !selectedDatabaseId.isEmpty {
                    await model.restore(databaseId: selectedDatabaseId, principal: appModel.principalText)
                }
            }
            .navigationTitle("Voice preview")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("End conversation", role: .destructive) { model.end() } }
            }
            .confirmationDialog("Start paid voice?", isPresented: Binding(get: { model.quote != nil }, set: { if !$0 { model.quote = nil } }), titleVisibility: .visible) {
                if let quote = model.quote {
                    Button("Start voice") { Task { await model.startVoice(quote: quote) } }
                    Button("Cancel", role: .cancel) { model.quote = nil }
                }
            } message: {
                if let quote = model.quote {
                    Text("Pay from \(selectedDatabaseTitle): \(quote.cyclesPerMinute) cycles/minute, billed per second. Maximum \(quote.maximumCycles) cycles for \(quote.maximumSeconds / 60) minutes. Silence, mute and lock time are included.")
                }
            }
            .alert("Source updated", isPresented: Binding(get: { changedCitation != nil }, set: { if !$0 { changedCitation = nil } })) {
                Button("Open current version") { if let citation = changedCitation { open(citation) }; changedCitation = nil }
                Button("Cancel", role: .cancel) { changedCitation = nil }
            } message: { Text("This source has changed since the answer was generated.") }
            .onChange(of: appModel.selectedAskAIDatabaseId) {
                guard model.snapshot == nil else { return }
                selectedDatabaseId = appModel.selectedAskAIDatabaseId
                showPolicy = false
                changedCitation = nil
                consent = false
            }
            .onChange(of: appModel.principalText) { showPolicy = false; changedCitation = nil; consent = false }
            .sheet(isPresented: $showPolicy) {
                VoicePolicyView(
                    appModel: appModel,
                    databaseId: selectedDatabaseId,
                    databaseTitle: selectedDatabaseTitle
                )
            }
        }
    }
    private func open(_ citation: AssistantCitation) {
        appModel.openAskAISource(databaseId: citation.databaseId, path: citation.path)
        dismiss()
    }
}

private struct VoicePolicyView: View {
    @Bindable var appModel: AppModel
    let databaseId: String
    let databaseTitle: String
    @State private var principal = ""
    @State private var budget = "0"
    @State private var enabled = false
    @State private var message: String?
    @State private var saving = false
    var body: some View {
        NavigationStack {
            Form {
                Text("Allow a database member to use the preview. Voice fees are paid from this database's cycles balance.")
                LabeledContent("Database", value: databaseTitle)
                TextField("Member principal", text: $principal).textInputAutocapitalization(.never).autocorrectionDisabled()
                Toggle("Allow preview", isOn: $enabled)
                TextField("Daily budget in cycles (UTC)", text: $budget).keyboardType(.numberPad)
                Button("Save permission and budget") {
                    guard let amount = UInt64(budget) else { message = "Enter a whole number of cycles."; return }
                    saving = true
                    Task {
                        defer { saving = false }
                        do { try await appModel.saveVoicePolicy(databaseId: databaseId, principal: principal, enabled: enabled, budget: amount); message = "Saved." }
                        catch { message = error.localizedDescription }
                    }
                }.disabled(saving || principal.isEmpty)
                if let message { Text(message) }
            }.navigationTitle("Preview access")
        }
    }
}
