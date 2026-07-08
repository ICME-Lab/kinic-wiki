// Where: mobile/ios/KinicApp/Views/BrowseDatabaseListView.swift
// What: Sidebar database list for readable Kinic Wiki databases.
// Why: Browsing starts from the user's visible DBs, including Reader-only databases.

import SwiftUI

struct BrowseDatabaseListView: View {
    @Bindable var model: AppModel
    @Binding var selectedDatabaseId: String?
    @Binding var selectedDocumentPath: String?
    @Binding var folderPath: [BrowseFolderRoute]

    var body: some View {
        Group {
            if model.canListBrowseDatabases {
                List(selection: $selectedDatabaseId) {
                    databaseRows
                }
                .overlay {
                    if model.browseListDatabases.isEmpty {
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
                    .disabled(!model.canListBrowseDatabases || model.isLoadingDatabases)
            }
        }
    }

    private var databaseRows: some View {
        ForEach(model.browseListDatabases) { database in
            NavigationLink(value: database.databaseId) {
                databaseRowLabel(database)
            }
        }
    }

    private func databaseRowLabel(_ database: DatabaseSummary) -> some View {
        BrowseDatabaseRow(
            database: database,
            isSelected: selectedDatabaseId == database.databaseId,
            isPublicReadable: model.isPublicBrowseDatabase(database.databaseId),
            isPurchased: model.isPurchasedBrowseDatabase(database.databaseId)
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func selectCurrentDatabase() {
        guard let databaseId = selectedDatabaseId else {
            return
        }
        selectedDocumentPath = nil
        folderPath = []
        if databaseId != model.selectedBrowseDatabaseId {
            model.selectBrowseDatabase(databaseId)
        }
    }

    private func refresh() {
        model.startRefreshDatabases()
    }
}

struct DatabaseManagementFormContent: View {
    @Bindable var model: AppModel
    let database: DatabaseSummary
    @State private var editDraft: DatabaseMetadataFieldDraft?
    @State private var isGrantAccessPresented = false
    @State private var accessConfirmation: PendingDatabaseAccessConfirmation?
    @State private var deleteDraft: DatabaseDeleteDraft?

    var body: some View {
        Group {
            Section("Database") {
                metadataContent("Name", value: database.displayTitle, field: .name)
                metadataContent("Description", value: databaseDescription, field: .description)
                metadataContent("Tags", value: databaseTags, field: .tags)
                metadataContent("LLM summary", value: databaseLLMSummary, field: .llmSummary)
                LabeledContent("Role", value: database.role.displayName)
                LabeledContent("Status", value: database.status.displayName)
                selectableContent("Database ID", value: database.databaseId)
            }

            publicSection
            accessSection

            Section("Cycles") {
                statusContent
                LabeledContent("Logical size", value: DatabaseManagementFormat.bytes(database.logicalSizeBytes))
                LabeledContent("Cycles balance", value: DatabaseManagementFormat.cycles(database.cyclesBalance))
                LabeledContent("Suspended since", value: DatabaseManagementFormat.date(milliseconds: database.cyclesSuspendedAtMs))
            }

            cycleHistorySection

            if database.role.canManageDatabase {
                dangerZoneSection
            }
        }
        .sheet(item: $editDraft) { draft in
            BrowseDatabaseMetadataEditView(model: model, draft: draft)
        }
        .sheet(item: $deleteDraft) { draft in
            DatabaseDeleteConfirmView(model: model, draft: draft)
        }
        .sheet(isPresented: $isGrantAccessPresented) {
            DatabaseGrantAccessView(
                error: model.databaseMembersError,
                isBusy: model.databaseAccessBusyAction != nil,
                onClearError: {
                    model.databaseMembersError = nil
                },
                onGrant: { principal, role in
                    requestGrant(principal: principal, role: role, existingMember: nil)
                }
            )
                .presentationDetents([.medium, .large])
        }
        .confirmationDialog(
            accessConfirmation?.title ?? "Confirm access change",
            isPresented: accessConfirmationPresented,
            titleVisibility: .visible
        ) {
            if let confirmation = accessConfirmation {
                Button(confirmation.confirmLabel, role: confirmation.buttonRole) {
                    apply(confirmation)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let confirmation = accessConfirmation {
                Text(confirmation.message)
            }
        }
        .task(id: database.databaseId) {
            model.startLoadCyclesBillingConfigIfNeeded()
            model.startLoadDatabaseManagementDetails(databaseId: database.databaseId)
        }
    }

    @ViewBuilder
    private var publicSection: some View {
        Section("Public") {
            if isPublicEnabled {
                Link("Open public database", destination: publicDatabaseURL)
                ShareLink("Share public database", item: publicDatabaseURL)
            } else {
                Text("Public access is disabled.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var accessSection: some View {
        Section("Access") {
            if model.isLoadingDatabaseMembers && model.databaseMembers.isEmpty {
                ProgressView()
                    .tint(KinicDesign.hotPink)
            }

            if let error = model.databaseMembersError {
                Text(error)
                    .foregroundStyle(.red)
            }

            if database.role.canManageDatabase {
                quickAccessActions
                Button("Grant access", systemImage: "person.badge.plus") {
                    model.databaseMembersError = nil
                    isGrantAccessPresented = true
                }
                .disabled(model.databaseAccessBusyAction != nil)
            }

            if model.databaseMembers.isEmpty && !model.isLoadingDatabaseMembers {
                Text("No members.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.databaseMembers) { member in
                    DatabaseMemberRow(
                        member: member,
                        canManage: database.role.canManageDatabase,
                        busyAction: model.databaseAccessBusyAction,
                        onGrant: { role in
                            _ = requestGrant(principal: member.principal, role: role, existingMember: member)
                        },
                        onRevoke: {
                            requestRevoke(member)
                        }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var quickAccessActions: some View {
        HStack {
            Button(isPublicEnabled ? "Disable public" : "Enable public") {
                if let publicMember {
                    accessConfirmation = .revokePublic(principal: publicMember.principal)
                } else {
                    accessConfirmation = .grantPublic
                }
            }
            .buttonStyle(.borderless)
            .disabled(model.databaseAccessBusyAction != nil)

            Spacer()

            Button(isLLMWriterEnabled ? "Disable LLM writer" : "Enable LLM writer") {
                if isLLMWriterEnabled, let llmWriterMember {
                    accessConfirmation = .revokeLLMWriter(principal: llmWriterMember.principal)
                } else {
                    accessConfirmation = .grantLLMWriter
                }
            }
            .buttonStyle(.borderless)
            .disabled(model.databaseAccessBusyAction != nil)
        }
    }

    @ViewBuilder
    private var cycleHistorySection: some View {
        Section("Pending Purchases") {
            if model.isLoadingDatabasePendingPurchases && model.databaseCyclesPendingPurchases.isEmpty {
                ProgressView()
                    .tint(KinicDesign.hotPink)
            }
            if let error = model.databasePendingPurchasesError {
                Text(error)
                    .foregroundStyle(.red)
            }
            if model.databaseCyclesPendingPurchases.isEmpty && !model.isLoadingDatabasePendingPurchases {
                Text("No pending purchases.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.databaseCyclesPendingPurchases) { purchase in
                    PendingPurchaseRow(purchase: purchase)
                }
            }
        }

        Section("Cycle Ledger") {
            if let error = model.databaseCyclesHistoryError {
                Text(error)
                    .foregroundStyle(.red)
            }

            LabeledContent("Page", value: "\(model.databaseCycleEntryPageIndex + 1)")

            if model.isLoadingDatabaseCycleEntries && model.databaseCycleEntries.isEmpty {
                ProgressView()
                    .tint(KinicDesign.hotPink)
            }

            if model.databaseCycleEntries.isEmpty && !model.isLoadingDatabaseCycleEntries {
                Text("No ledger entries.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(model.databaseCycleEntries) { entry in
                    CycleEntryRow(entry: entry)
                }
            }

            HStack {
                Button("Previous page") {
                    model.startLoadPreviousDatabaseCycleEntries(databaseId: database.databaseId)
                }
                .frame(minHeight: 44)
                .disabled(model.isLoadingDatabaseCycleEntries || model.databaseCycleEntryPreviousCursors.isEmpty)

                Spacer()

                Button("Next page") {
                    model.startLoadNextDatabaseCycleEntries(databaseId: database.databaseId)
                }
                .frame(minHeight: 44)
                .disabled(model.isLoadingDatabaseCycleEntries || model.databaseCycleEntriesNextCursor == nil)
            }
        }
    }

    private var dangerZoneSection: some View {
        Section("Danger Zone") {
            Text("Delete is irreversible. Remaining cycles will be discarded.")
                .foregroundStyle(.red)
            Button("Delete database", systemImage: "trash", role: .destructive) {
                model.databaseDeleteError = nil
                deleteDraft = DatabaseDeleteDraft(database: database)
            }
            .disabled(model.databaseAccessBusyAction != nil)
        }
    }

    @ViewBuilder
    private func metadataContent(_ title: String, value: String, field: DatabaseMetadataField) -> some View {
        if database.role.canManageDatabase {
            Button {
                edit(field)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title)
                            .foregroundStyle(.primary)
                        Text(value)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }

                    Spacer(minLength: 12)

                    Image(systemName: "pencil")
                        .imageScale(.medium)
                        .foregroundStyle(KinicDesign.hotPink)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.isUpdatingDatabaseMetadata)
        } else {
            LabeledContent(title, value: value)
        }
    }

    private var statusContent: some View {
        HStack(alignment: .center, spacing: 12) {
            Text("Management status")

            Spacer(minLength: 12)

            HStack(spacing: 6) {
                Image(systemName: managementStatus.systemImage)
                    .imageScale(.medium)

                Text(managementStatus.displayName)
            }
            .foregroundStyle(managementStatus.tint)
        }
        .accessibilityElement(children: .combine)
    }

    private var managementStatus: DatabaseManagementStatus {
        DatabaseManagementStatus.status(for: database, config: model.cyclesBillingConfig)
    }

    private var publicMember: DatabaseMember? {
        model.databaseMembers.first { $0.principal == DatabaseAccessConstants.anonymousPrincipal }
    }

    private var isPublicEnabled: Bool {
        publicMember != nil
    }

    private var llmWriterMember: DatabaseMember? {
        model.databaseMembers.first { $0.principal == DatabaseAccessConstants.llmWriterPrincipal }
    }

    private var isLLMWriterEnabled: Bool {
        llmWriterMember?.role == .writer
    }

    private var publicDatabaseURL: URL {
        model.configuration.authOrigin
            .appending(path: "db")
            .appending(path: database.databaseId)
            .appending(path: "Knowledge")
    }

    private var accessConfirmationPresented: Binding<Bool> {
        Binding {
            accessConfirmation != nil
        } set: { isPresented in
            if !isPresented {
                accessConfirmation = nil
            }
        }
    }

    private func edit(_ field: DatabaseMetadataField) {
        model.databaseMetadataError = nil
        editDraft = DatabaseMetadataFieldDraft(database: database, field: field)
    }

    private func requestGrant(principal: String, role: DatabaseRole, existingMember: DatabaseMember?) -> Bool {
        if principal == DatabaseAccessConstants.anonymousPrincipal && role != .reader {
            model.databaseMembersError = "Anonymous principal can only be Reader."
            return false
        }
        if principal == DatabaseAccessConstants.anonymousPrincipal {
            accessConfirmation = .grantPublic
            return true
        }
        if principal == DatabaseAccessConstants.llmWriterPrincipal && role == .writer {
            accessConfirmation = .grantLLMWriter
            return true
        }
        if role == .owner || existingMember?.role == .owner {
            accessConfirmation = .grantPrincipal(principal: principal, role: role)
            return true
        }
        Task {
            _ = await model.grantDatabaseAccess(databaseId: database.databaseId, principal: principal, role: role)
        }
        return true
    }

    private func requestRevoke(_ member: DatabaseMember) {
        if member.principal == DatabaseAccessConstants.anonymousPrincipal {
            accessConfirmation = .revokePublic(principal: member.principal)
            return
        }
        if member.principal == DatabaseAccessConstants.llmWriterPrincipal {
            accessConfirmation = .revokeLLMWriter(principal: member.principal)
            return
        }
        if member.role == .owner {
            accessConfirmation = .revokePrincipal(principal: member.principal, role: member.role)
            return
        }
        Task {
            _ = await model.revokeDatabaseAccess(databaseId: database.databaseId, principal: member.principal)
        }
    }

    private func apply(_ confirmation: PendingDatabaseAccessConfirmation) {
        Task {
            switch confirmation.action {
            case .grant(let principal, let role):
                _ = await model.grantDatabaseAccess(databaseId: database.databaseId, principal: principal, role: role)
            case .revoke(let principal):
                _ = await model.revokeDatabaseAccess(databaseId: database.databaseId, principal: principal)
            }
        }
    }

    private var databaseDescription: String {
        database.description.isEmpty ? "None" : database.description
    }

    private var databaseTags: String {
        database.metadata?.displayTags.isEmpty == false ? database.metadata?.displayTags ?? "None" : "None"
    }

    private var databaseLLMSummary: String {
        database.metadata?.llmSummary?.isEmpty == false ? database.metadata?.llmSummary ?? "None" : "None"
    }
}

private enum DatabaseAccessConstants {
    static let anonymousPrincipal = "2vxsx-fae"
    static let llmWriterPrincipal = "ckurn-x74ln-nemlm-42vfv-gej7r-4cc3e-v22e5-otcod-jndlh-pbst4-3qe"
    static let llmWriterLabel = "LLM writer"
}

private enum PendingDatabaseAccessAction: Equatable {
    case grant(principal: String, role: DatabaseRole)
    case revoke(principal: String)
}

private struct PendingDatabaseAccessConfirmation: Identifiable, Equatable {
    let id: String
    let title: String
    let message: String
    let confirmLabel: String
    let buttonRole: ButtonRole?
    let action: PendingDatabaseAccessAction

    static var grantPublic: PendingDatabaseAccessConfirmation {
        PendingDatabaseAccessConfirmation(
            id: "grant-public",
            title: "Enable public access",
            message: "Grant Reader access to anonymous principal \(DatabaseAccessConstants.anonymousPrincipal). Anyone can read this database through the public browser.",
            confirmLabel: "Enable public",
            buttonRole: nil,
            action: .grant(principal: DatabaseAccessConstants.anonymousPrincipal, role: .reader)
        )
    }

    static func revokePublic(principal: String) -> PendingDatabaseAccessConfirmation {
        PendingDatabaseAccessConfirmation(
            id: "revoke-public",
            title: "Disable public access",
            message: "Revoke anonymous Reader access. Public browser reads will stop for this database.",
            confirmLabel: "Disable public",
            buttonRole: .destructive,
            action: .revoke(principal: principal)
        )
    }

    static var grantLLMWriter: PendingDatabaseAccessConfirmation {
        PendingDatabaseAccessConfirmation(
            id: "grant-llm-writer",
            title: "Enable LLM writer",
            message: "Grant Writer access to \(DatabaseAccessConstants.llmWriterLabel). Worker writes can create and update wiki drafts.",
            confirmLabel: "Enable LLM writer",
            buttonRole: nil,
            action: .grant(principal: DatabaseAccessConstants.llmWriterPrincipal, role: .writer)
        )
    }

    static func revokeLLMWriter(principal: String) -> PendingDatabaseAccessConfirmation {
        PendingDatabaseAccessConfirmation(
            id: "revoke-llm-writer",
            title: "Disable LLM writer",
            message: "Revoke \(DatabaseAccessConstants.llmWriterLabel) access. Worker writes will stop for this database.",
            confirmLabel: "Disable LLM writer",
            buttonRole: .destructive,
            action: .revoke(principal: principal)
        )
    }

    static func grantPrincipal(principal: String, role: DatabaseRole) -> PendingDatabaseAccessConfirmation {
        PendingDatabaseAccessConfirmation(
            id: "grant-\(principal)-\(role.rawValue)",
            title: role == .owner ? "Grant owner access" : "Grant access",
            message: "Grant \(role.displayName) access to \(principal).",
            confirmLabel: role == .owner ? "Grant owner" : "Grant",
            buttonRole: role == .owner ? .destructive : nil,
            action: .grant(principal: principal, role: role)
        )
    }

    static func revokePrincipal(principal: String, role: DatabaseRole) -> PendingDatabaseAccessConfirmation {
        PendingDatabaseAccessConfirmation(
            id: "revoke-\(principal)",
            title: role == .owner ? "Revoke owner access" : "Revoke access",
            message: "Revoke \(role.displayName) access from \(principal).",
            confirmLabel: role == .owner ? "Revoke owner" : "Revoke",
            buttonRole: .destructive,
            action: .revoke(principal: principal)
        )
    }
}

private struct DatabaseMemberRow: View {
    let member: DatabaseMember
    let canManage: Bool
    let busyAction: DatabaseAccessBusyAction?
    let onGrant: (DatabaseRole) -> Void
    let onRevoke: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(displayPrincipal)
                    .font(.system(.footnote, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer(minLength: 8)
                if !canManage {
                    Text(member.role.displayName)
                        .foregroundStyle(.primary)
                }
            }

            Text("Added \(DatabaseManagementFormat.date(milliseconds: member.createdAtMs))")
                .font(.caption)
                .foregroundStyle(.secondary)

            if canManage {
                HStack {
                    Menu {
                        ForEach(DatabaseRole.allCases, id: \.self) { role in
                            Button(role.displayName) {
                                onGrant(role)
                            }
                            .disabled(role == member.role || (member.principal == DatabaseAccessConstants.anonymousPrincipal && role != .reader))
                        }
                    } label: {
                        Text(member.role.displayName)
                            .foregroundStyle(.primary)
                    }
                    .tint(.primary)
                    .disabled(isBusy)

                    Spacer()

                    Button("Revoke", role: .destructive, action: onRevoke)
                        .disabled(isBusy)
                }
                .font(.subheadline)
            }
        }
        .padding(.vertical, 4)
    }

    private var displayPrincipal: String {
        member.principal == DatabaseAccessConstants.llmWriterPrincipal ? DatabaseAccessConstants.llmWriterLabel : member.principal
    }

    private var isBusy: Bool {
        switch busyAction {
        case .grant(let principal, _), .revoke(let principal):
            principal == member.principal
        case .delete, nil:
            false
        }
    }
}

private struct PendingPurchaseRow: View {
    let purchase: DatabaseCyclesPendingPurchase

    var body: some View {
        DisclosureGroup {
            selectableContent("Operation", value: "\(purchase.operationId)")
            selectableContent("Database", value: purchase.databaseId)
            LabeledContent("Required action", value: purchase.requiredAction)
            LabeledContent("Cycles", value: DatabaseManagementFormat.cycles(purchase.amountCycles))
            LabeledContent("Payment", value: DatabaseManagementFormat.tokenE8s(purchase.paymentAmountE8s))
            LabeledContent("Ledger block", value: purchase.ledgerBlockIndex.map(String.init) ?? "-")
            LabeledContent("Created", value: DatabaseManagementFormat.date(milliseconds: purchase.createdAtMs))
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(purchase.status)
                Text("Operation \(purchase.operationId)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct CycleEntryRow: View {
    let entry: DatabaseCycleEntry

    var body: some View {
        DisclosureGroup {
            selectableContent("Entry", value: "\(entry.entryId)")
            LabeledContent("Kind", value: entry.kind)
            selectableContent("Caller", value: entry.caller)
            LabeledContent("Amount", value: DatabaseManagementFormat.signedCycles(entry.amountCycles))
            LabeledContent("Balance after", value: DatabaseManagementFormat.cycles(entry.balanceAfterCycles))
            LabeledContent("Method", value: entry.method ?? "-")
            LabeledContent("Ledger block", value: entry.ledgerBlockIndex.map(String.init) ?? "-")
            LabeledContent("Payment", value: entry.paymentAmountE8s.map(DatabaseManagementFormat.tokenE8s) ?? "-")
            LabeledContent("Cycles per KINIC", value: entry.cyclesPerKinic.map(DatabaseManagementFormat.cycles) ?? "-")
            LabeledContent("Cycles delta", value: entry.cyclesDelta.map(DatabaseManagementFormat.cycles) ?? "-")
            LabeledContent("Created", value: DatabaseManagementFormat.date(milliseconds: entry.createdAtMs))
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.displayTitle)
                Text(DatabaseManagementFormat.signedCycles(entry.amountCycles))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

private struct DatabaseDeleteDraft: Identifiable, Equatable {
    let databaseId: String
    let databaseTitle: String
    var typedDatabaseId: String

    var id: String {
        databaseId
    }

    init(database: DatabaseSummary) {
        databaseId = database.databaseId
        databaseTitle = database.displayTitle
        typedDatabaseId = ""
    }
}

private struct DatabaseDeleteConfirmView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft: DatabaseDeleteDraft

    init(model: AppModel, draft: DatabaseDeleteDraft) {
        self.model = model
        _draft = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Delete Database") {
                    Text("This action is irreversible. Remaining cycles will be discarded.")
                        .foregroundStyle(.red)
                    selectableContent("Database", value: draft.databaseTitle)
                    selectableContent("Database ID", value: draft.databaseId)
                    TextField("Type database ID", text: $draft.typedDatabaseId)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                }

                if let error = model.databaseDeleteError {
                    Section("Error") {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Delete Database")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                        .disabled(model.databaseAccessBusyAction == .delete)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Delete", role: .destructive, action: delete)
                        .disabled(draft.typedDatabaseId != draft.databaseId || model.databaseAccessBusyAction == .delete)
                }
            }
        }
    }

    private func cancel() {
        model.databaseDeleteError = nil
        dismiss()
    }

    private func delete() {
        Task {
            let deleted = await model.deleteDatabase(databaseId: draft.databaseId)
            if deleted {
                dismiss()
            }
        }
    }
}

private struct DatabaseGrantAccessView: View {
    @Environment(\.dismiss) private var dismiss
    let error: String?
    let isBusy: Bool
    let onClearError: () -> Void
    let onGrant: (String, DatabaseRole) -> Bool
    @State private var principal = ""
    @State private var role = DatabaseRole.reader

    private var trimmedPrincipal: String {
        principal.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Principal") {
                    TextField("Principal", text: $principal)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.footnote, design: .monospaced))
                }

                Section("Role") {
                    Picker("Role", selection: $role) {
                        ForEach(DatabaseRole.allCases, id: \.self) { role in
                            Text(role.displayName).tag(role)
                        }
                    }
                }

                if let error {
                    Section("Error") {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Grant Access")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: cancel)
                        .disabled(isBusy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isBusy ? "Granting..." : "Grant", action: grant)
                        .disabled(trimmedPrincipal.isEmpty || isBusy)
                }
            }
        }
        .onAppear {
            onClearError()
        }
    }

    private func cancel() {
        onClearError()
        dismiss()
    }

    private func grant() {
        let principal = trimmedPrincipal
        if onGrant(principal, role) {
            dismiss()
        }
    }
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

private enum DatabaseMetadataField: String, Equatable {
    case name
    case description
    case tags
    case llmSummary

    var title: String {
        switch self {
        case .name:
            "Name"
        case .description:
            "Description"
        case .tags:
            "Tags"
        case .llmSummary:
            "LLM summary"
        }
    }

    var placeholder: String {
        switch self {
        case .name:
            "Team skills"
        case .description:
            "What this database contains"
        case .tags:
            "swift, ios"
        case .llmSummary:
            "Short summary for LLM context"
        }
    }

    var lineLimit: Int {
        switch self {
        case .name:
            1
        case .description:
            3
        case .tags:
            2
        case .llmSummary:
            4
        }
    }

    var footer: String? {
        switch self {
        case .name:
            "Use 1..80 characters."
        case .tags:
            "Comma-separated tags."
        case .description, .llmSummary:
            nil
        }
    }
}

private struct DatabaseMetadataFieldDraft: Identifiable, Equatable {
    let databaseId: String
    let field: DatabaseMetadataField
    let currentName: String
    let currentDescription: String
    let currentTagsInput: String
    let currentLLMSummary: String
    var value: String

    var id: String {
        "\(databaseId):\(field.rawValue)"
    }

    init(database: DatabaseSummary, field: DatabaseMetadataField) {
        databaseId = database.databaseId
        self.field = field
        currentName = database.metadata?.name ?? database.displayTitle
        currentDescription = database.metadata?.description ?? database.description
        currentTagsInput = database.metadata?.editTags ?? ""
        currentLLMSummary = database.metadata?.llmSummary ?? ""
        switch field {
        case .name:
            value = currentName
        case .description:
            value = currentDescription
        case .tags:
            value = currentTagsInput
        case .llmSummary:
            value = currentLLMSummary
        }
    }

    var name: String {
        field == .name ? value : currentName
    }

    var description: String {
        field == .description ? value : currentDescription
    }

    var tagsInput: String {
        field == .tags ? value : currentTagsInput
    }

    var llmSummary: String {
        field == .llmSummary ? value : currentLLMSummary
    }

    var canSave: Bool {
        switch field {
        case .name:
            AppModel.databaseNameError(value.trimmingCharacters(in: .whitespacesAndNewlines)) == nil
        case .description, .tags, .llmSummary:
            true
        }
    }
}

private struct BrowseDatabaseMetadataEditView: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var draft: DatabaseMetadataFieldDraft

    init(model: AppModel, draft: DatabaseMetadataFieldDraft) {
        self.model = model
        _draft = State(initialValue: draft)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if draft.field == .name {
                        TextField(draft.field.placeholder, text: $draft.value)
                            .textInputAutocapitalization(.words)
                    } else {
                        TextField(draft.field.placeholder, text: $draft.value, axis: .vertical)
                            .lineLimit(draft.field.lineLimit...)
                    }
                } header: {
                    Text(draft.field.title)
                } footer: {
                    if let footer = draft.field.footer {
                        Text(footer)
                    }
                }

                if let error = model.databaseMetadataError {
                    Section("Error") {
                        Text(error)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Edit \(draft.field.title)")
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
                databaseId: draft.databaseId,
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
