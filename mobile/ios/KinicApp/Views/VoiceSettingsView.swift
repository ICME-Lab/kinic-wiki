import SwiftUI

struct VoiceSettingsView: View {
    @Bindable var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var principal = ""
    @State private var members: [DatabaseMember] = []
    @State private var access: VoiceAccessInfo?
    @State private var enabled = false
    @State private var budget = ""
    @State private var unit = CycleBudgetUnit.cycles
    @State private var scope = "/Knowledge"
    @State private var busy = false
    @State private var message: String?
    @State private var pendingDatabase: String?
    @State private var pendingPrincipal: String?
    @State private var confirmDiscard = false
    @State private var closeRequested = false
    @FocusState private var budgetFocused: Bool
    private var databaseID: String { appModel.selectedDatabaseId }
    private var owner: Bool { appModel.askAIDatabaseCandidates.first { $0.databaseId == databaseID }?.role == .owner }
    private var dirty: Bool {
        guard let access else { return false }
        return enabled != access.policy.enabled || unit.cycles(from: budget) != access.policy.budget
    }
    private var loadKey: String { appModel.principalText + "|" + databaseID + "|" + principal }

    var body: some View {
        Form {
            Section("Search Scope") {
                Picker("Scope", selection: $scope) { Text("Knowledge").tag("/Knowledge"); Text("Memory").tag("/Memory") }
                    .disabled(appModel.databaseSelectionLocked)
                    .onChange(of: scope) { UserDefaults.standard.set(scope, forKey: "voice.scope.\(appModel.principalText)") }
            }
            Section("Access and Budget") {
                Picker("Database", selection: Binding(get: { databaseID }, set: { id in
                    guard id != databaseID else { return }
                    pendingDatabase = id
                    requestChange()
                })) {
                    ForEach(appModel.askAIDatabaseCandidates) { Text($0.displayTitle).tag($0.databaseId) }
                }.disabled(busy || appModel.databaseSelectionLocked)
                if appModel.databaseSelectionLocked { Text(appModel.databaseSelectionLockReason).font(.caption) }
                if owner {
                    Picker("User", selection: Binding(get: { principal }, set: { id in
                        pendingPrincipal = id
                        requestChange()
                    })) {
                        Text("Me").tag(appModel.principalText)
                        ForEach(members.filter { $0.principal != appModel.principalText }) { Text($0.principal).tag($0.principal) }
                    }.disabled(busy)
                }
                if busy { ProgressView() }
                if let access {
                    Toggle("Enable Voice", isOn: $enabled).disabled(!owner || busy)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Daily Limit")
                        HStack {
                            TextField("Limit", text: $budget)
                                .keyboardType(.decimalPad)
                                .focused($budgetFocused)
                                .accessibilityLabel("Daily limit, in \(unit.title)")
                                .accessibilityIdentifier("voice.dailyLimit")
                            Text(unit.title)
                                .foregroundStyle(.secondary)
                        }
                        if unit.cycles(from: budget) == nil {
                            Text("Enter an amount that resolves to a whole number of cycles from 0 through \(Int64.max).")
                                .font(.caption).foregroundStyle(.red)
                        }
                    }.disabled(!owner || busy)
                    cycleRow("Rate per minute", value: access.rate.cyclesPerMinute)
                    cycleRow("Remaining today", value: access.remainingCycles)
                    cycleRow("Database balance", value: access.balanceCycles)
                    Text("Resets daily at 9:00 AM JST (12:00 AM UTC). Silence and muted time still count as connected time. The limit does not increase automatically when the rate changes.").font(.caption)
                    if owner { Button("Save") { save() }.disabled(busy || unit.cycles(from: budget) == nil) }
                    else { Text("Only the database owner can change voice access and budgets.") }
                }
                if let message { Text(message) }
            }
        }
        .navigationTitle("Voice Settings")
        .navigationBarBackButtonHidden(true)
        .toolbar { ToolbarItem(placement: .topBarLeading) {
            Button("Back", systemImage: "chevron.left") { closeRequested = true; requestChange() }.disabled(busy)
        } }
        .interactiveDismissDisabled(dirty || busy)
        .confirmationDialog("Discard unsaved changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard Changes", role: .destructive) { applyChange() }
            Button("Cancel", role: .cancel) { resetPending() }
        }
        .task {
            scope = UserDefaults.standard.string(forKey: "voice.scope.\(appModel.principalText)") ?? "/Knowledge"
            principal = appModel.principalText
        }
        .onChange(of: databaseID) { principal = appModel.principalText; access = nil; members = [] }
        .onChange(of: appModel.principalText) {
            principal = appModel.principalText; access = nil; members = []; resetPending()
            scope = UserDefaults.standard.string(forKey: "voice.scope.\(appModel.principalText)") ?? "/Knowledge"
        }
        .onChange(of: dirty || busy) { _, value in appModel.voiceSettingsHasChanges = value }
        .onChange(of: budgetFocused) { _, focused in
            guard !focused else { return }
            normalizeBudgetPresentation()
        }
        .onDisappear { appModel.voiceSettingsHasChanges = false }
        .task(id: loadKey) { await load() }
    }
    private func cycleRow(_ title: String, value: UInt64) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                    Text(DatabaseManagementFormat.cycles(value)).foregroundStyle(.secondary)
                }
            } else {
                LabeledContent(title, value: DatabaseManagementFormat.cycles(value))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityIdentifier("voice.cycles.\(title)")
        .accessibilityValue("\(value) cycles")
    }
    private func requestChange() { if dirty { confirmDiscard = true } else { applyChange() } }
    private func resetPending() { pendingDatabase = nil; pendingPrincipal = nil; closeRequested = false }
    private func applyChange() {
        if closeRequested { dismiss() }
        else if let id = pendingDatabase { _ = appModel.requestBrowseDatabaseSelection(id) }
        else if let id = pendingPrincipal { principal = id }
        resetPending()
    }
    private func load() async {
#if DEBUG
        if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "voice-settings" {
            let info = VoiceAccessInfo.settingsPreview
            access = info; enabled = true
            applyBudgetPresentation(value: info.policy.budget, fallback: info.rate.cyclesPerMinute)
            return
        }
#endif
        let key = loadKey
        guard !databaseID.isEmpty, !principal.isEmpty else { access = nil; busy = false; return }
        busy = true; message = nil; access = nil
        defer { if key == loadKey { busy = false } }
        do {
            let db = databaseID, user = principal, isOwner = owner
            let info = try await appModel.voiceAccess(databaseId: db, principal: user, initializeOwner: isOwner && user == appModel.principalText)
            let loadedMembers = isOwner ? try await appModel.voiceMembers(databaseId: db) : []
            try Task.checkCancellation()
            guard key == loadKey else { return }
            access = info; enabled = info.policy.enabled
            applyBudgetPresentation(value: info.policy.budget, fallback: info.rate.cyclesPerMinute)
            members = loadedMembers
        } catch is CancellationError {} catch { if key == loadKey { message = error.localizedDescription } }
    }
    private func save() {
        guard let value = unit.cycles(from: budget) else { return }
        let key = loadKey, db = databaseID, user = principal, allowed = enabled
        busy = true
        Task {
            do {
                try await appModel.saveVoicePolicy(databaseId: db, principal: user, enabled: allowed, budget: value)
                guard key == loadKey else { return }
                await load(); message = "Saved."
            } catch { if key == loadKey { message = error.localizedDescription; busy = false } }
        }
    }
    private func applyBudgetPresentation(value: UInt64, fallback: UInt64) {
        let presentation = CycleBudgetUnit.presentation(for: value, fallback: fallback)
        unit = presentation.unit
        budget = presentation.text
    }
    private func normalizeBudgetPresentation() {
        guard let normalized = unit.normalizedPresentation(
            for: budget,
            fallback: access?.rate.cyclesPerMinute ?? 0
        ) else { return }
        unit = normalized.unit
        budget = normalized.text
    }
}
