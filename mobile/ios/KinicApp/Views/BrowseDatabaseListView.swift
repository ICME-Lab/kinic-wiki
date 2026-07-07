// Where: mobile/ios/KinicApp/Views/BrowseDatabaseListView.swift
// What: Sidebar database list for readable Kinic Wiki databases.
// Why: Browsing starts from the user's visible DBs, including Reader-only databases.

import SwiftUI

struct BrowseDatabaseListView: View {
    @Bindable var model: AppModel
    @Binding var selectedDatabaseId: String?
    @Binding var selectedDocumentPath: String?
    @Binding var selectedManageDatabaseId: String?
    @Binding var folderPath: [BrowseFolderRoute]

    var body: some View {
        Group {
            if model.isSignedIn {
                List(selection: $selectedDatabaseId) {
                    databaseRows
                }
                .overlay {
                    if model.readableDatabases.isEmpty {
                        ContentUnavailableView("No readable databases", systemImage: "externaldrive")
                    }
                }
            } else {
                BrowseSignedOutView(model: model)
            }
        }
        .navigationTitle("Databases")
        .onChange(of: selectedDatabaseId) {
            selectCurrentDatabase()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
                    .disabled(!model.isSignedIn || model.isLoadingDatabases)
            }
        }
    }

    private var databaseRows: some View {
        ForEach(model.readableDatabases) { database in
            HStack(spacing: 8) {
                NavigationLink(value: database.databaseId) {
                    BrowseDatabaseRow(database: database, isSelected: selectedDatabaseId == database.databaseId)
                }

                Button(database.role.canManageDatabase ? "Manage Database" : "Database Info", systemImage: database.role.canManageDatabase ? "gearshape" : "info.circle") {
                    openManagement(database)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .foregroundStyle(KinicDesign.hotPink)
                .frame(minWidth: 44, minHeight: 44)
            }
        }
    }

    private func selectCurrentDatabase() {
        guard let databaseId = selectedDatabaseId,
              databaseId != model.selectedBrowseDatabaseId else {
            return
        }
        selectedDocumentPath = nil
        folderPath = []
        model.selectBrowseDatabase(databaseId)
    }

    private func openManagement(_ database: DatabaseSummary) {
        selectedDatabaseId = database.databaseId
        selectedDocumentPath = nil
        selectedManageDatabaseId = database.databaseId
        folderPath = []
        model.selectBrowseDatabase(database.databaseId)
        model.startLoadCyclesBillingConfigIfNeeded()
    }

    private func refresh() {
        model.startRefreshDatabases()
    }
}

struct BrowseDatabaseManageView: View {
    @Bindable var model: AppModel
    let database: DatabaseSummary
    @State private var editDraft: DatabaseMetadataDraft?

    var body: some View {
        Form {
            Section("Database") {
                LabeledContent("Name", value: database.displayTitle)
                LabeledContent("Description", value: database.description.isEmpty ? "None" : database.description)
                LabeledContent("Tags", value: database.metadata?.displayTags.isEmpty == false ? database.metadata?.displayTags ?? "None" : "None")
                LabeledContent("LLM summary", value: database.metadata?.llmSummary?.isEmpty == false ? database.metadata?.llmSummary ?? "None" : "None")
                LabeledContent("Role", value: database.role.displayName)
                LabeledContent("Status", value: database.status.displayName)
                selectableContent("Database ID", value: database.databaseId)
            }

            Section("Cycles") {
                statusContent
                LabeledContent("Logical size", value: DatabaseManagementFormat.bytes(database.logicalSizeBytes))
                LabeledContent("Cycles balance", value: DatabaseManagementFormat.cycles(database.cyclesBalance))
                LabeledContent("Suspended since", value: DatabaseManagementFormat.date(milliseconds: database.cyclesSuspendedAtMs))
            }

            Section("Billing") {
                billingConfigContent
            }

            Section("Refresh") {
                LabeledContent("Last refreshed", value: DatabaseManagementFormat.date(lastRefreshed))
            }
        }
        .navigationTitle(database.role.canManageDatabase ? "Manage Database" : "Database Info")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if database.role.canManageDatabase {
                    Button("Edit", systemImage: "pencil", action: edit)
                        .disabled(model.isUpdatingDatabaseMetadata)
                }
                Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
                    .disabled(model.isLoadingDatabases || model.isLoadingCyclesConfig)
            }
        }
        .sheet(item: $editDraft) { draft in
            BrowseDatabaseMetadataEditView(model: model, draft: draft)
        }
        .task {
            model.startLoadCyclesBillingConfigIfNeeded()
        }
    }

    private var statusContent: some View {
        LabeledContent("Management status") {
            Label(managementStatus.displayName, systemImage: managementStatus.systemImage)
                .foregroundStyle(managementStatus.tint)
        }
    }

    @ViewBuilder
    private var billingConfigContent: some View {
        if model.isLoadingCyclesConfig && model.cyclesBillingConfig == nil {
            ProgressView()
                .tint(KinicDesign.hotPink)
        }

        if let error = model.cyclesConfigError {
            Text(error)
                .foregroundStyle(.red)
            Button("Retry", systemImage: "arrow.clockwise", action: model.startLoadCyclesBillingConfigIfNeeded)
        }

        if let config = model.cyclesBillingConfig {
            LabeledContent("Min update cycles", value: DatabaseManagementFormat.cycles(config.minUpdateCycles))
            LabeledContent("Top-up enabled", value: config.topUp.enabled ? "Yes" : "No")
            LabeledContent("Top-up threshold", value: DatabaseManagementFormat.cycles(config.topUp.thresholdCycles))
            LabeledContent("Cycles per KINIC", value: DatabaseManagementFormat.cycles(config.cyclesPerKinic))
            selectableContent("Billing authority", value: config.billingAuthorityId)
            selectableContent("Ledger canister", value: config.kinicLedgerCanisterId)
        } else if model.cyclesConfigError == nil && !model.isLoadingCyclesConfig {
            Text("Billing config unavailable.")
                .foregroundStyle(.secondary)
        }
    }

    private var managementStatus: DatabaseManagementStatus {
        DatabaseManagementStatus.status(for: database, config: model.cyclesBillingConfig)
    }

    private var lastRefreshed: Date? {
        [model.databaseListLastRefreshed, model.cyclesConfigLastRefreshed]
            .compactMap { $0 }
            .max()
    }

    private func refresh() {
        model.startRefreshDatabaseManagementInfo()
    }

    private func edit() {
        model.databaseMetadataError = nil
        editDraft = DatabaseMetadataDraft(database: database)
    }

    private func selectableContent(_ title: String, value: String) -> some View {
        LabeledContent(title) {
            Text(value)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}

private struct DatabaseMetadataDraft: Identifiable, Equatable {
    let id: String
    var name: String
    var description: String
    var tagsInput: String
    var llmSummary: String

    init(database: DatabaseSummary) {
        id = database.databaseId
        name = database.metadata?.name ?? database.displayTitle
        description = database.metadata?.description ?? database.description
        tagsInput = database.metadata?.editTags ?? ""
        llmSummary = database.metadata?.llmSummary ?? ""
    }

    var canSave: Bool {
        AppModel.databaseNameError(name.trimmingCharacters(in: .whitespacesAndNewlines)) == nil
    }
}

private struct BrowseDatabaseMetadataEditView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft: DatabaseMetadataDraft

    init(model: AppModel, draft: DatabaseMetadataDraft) {
        self.model = model
        _draft = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Database") {
                    TextField("Name", text: $draft.name)
                    TextField("Description", text: $draft.description, axis: .vertical)
                        .lineLimit(3...)
                    TextField("Tags", text: $draft.tagsInput, axis: .vertical)
                        .lineLimit(2...)
                    TextField("LLM summary", text: $draft.llmSummary, axis: .vertical)
                        .lineLimit(4...)
                }

                if let error = model.databaseMetadataError {
                    Section("Error") {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Edit Database")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                        .disabled(model.isUpdatingDatabaseMetadata)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(!draft.canSave || model.isUpdatingDatabaseMetadata)
                }
            }
        }
    }

    private func cancel() {
        model.databaseMetadataError = nil
        dismiss()
    }

    private func save() {
        Task {
            let saved = await model.updateDatabaseMetadata(
                databaseId: draft.id,
                name: draft.name,
                description: draft.description,
                tagsInput: draft.tagsInput,
                llmSummary: draft.llmSummary
            )
            if saved {
                dismiss()
            }
        }
    }
}

private extension DatabaseManagementStatus {
    var systemImage: String {
        switch self {
        case .suspended:
            "pause.circle"
        case .unknown:
            "questionmark.circle"
        case .blocked:
            "exclamationmark.octagon"
        case .low:
            "exclamationmark.triangle"
        case .ok:
            "checkmark.circle"
        }
    }

    var tint: Color {
        switch self {
        case .suspended, .blocked:
            .red
        case .low:
            .orange
        case .unknown:
            .secondary
        case .ok:
            .green
        }
    }
}
