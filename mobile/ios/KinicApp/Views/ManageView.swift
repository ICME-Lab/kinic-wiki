// Where: mobile/ios/KinicApp/Views/ManageView.swift
// What: Database management surface for the selected readable wiki database.
// Why: Browse and Settings should stay focused while Manage owns database configuration.

import SwiftUI

struct ManageView: View {
    @Bindable var model: AppModel

    var body: some View {
        Group {
            if model.isSignedIn {
                Form {
                    databasePickerSection

                    if let database = selectedManageDatabase {
                        DatabaseManagementFormContent(model: model, database: database)
                    } else if !model.isLoadingDatabases && !model.managementDatabases.isEmpty {
                        Section("Management") {
                            Text("Select a database to manage.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                ManageSignedOutView(model: model)
            }
        }
        .navigationTitle("Manage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.startRefreshDatabases()
        }
        .onChange(of: model.selectedBrowseDatabaseId) { _, databaseId in
            guard model.readableDatabases.contains(where: { $0.databaseId == databaseId }) else {
                return
            }
            model.selectBrowseDatabase(databaseId)
            model.startLoadCyclesBillingConfigIfNeeded()
        }
    }

    @ViewBuilder
    private var databasePickerSection: some View {
        Section("Database") {
            if model.isLoadingDatabases && model.managementDatabases.isEmpty {
                ProgressView()
                    .tint(KinicDesign.hotPink)
            } else if model.managementDatabases.isEmpty {
                Text("No manageable databases.")
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 12) {
                    Picker("Database", selection: $model.selectedBrowseDatabaseId) {
                        ForEach(model.managementDatabases) { database in
                            Text(pickerTitle(for: database))
                                .tag(database.databaseId)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(KinicDesign.hotPink)
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Button("Refresh databases", systemImage: "arrow.clockwise", action: refreshManagement)
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .foregroundStyle(KinicDesign.hotPink)
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(!model.isSignedIn || model.isLoadingDatabases || model.isLoadingCyclesConfig)
                }
            }
        }
    }

    private var selectedManageDatabase: DatabaseSummary? {
        model.managementDatabases.first { $0.databaseId == model.selectedBrowseDatabaseId }
    }

    private func pickerTitle(for database: DatabaseSummary) -> String {
        let badges = [
            model.isPublicBrowseDatabase(database.databaseId) ? "Public" : nil,
            model.isPurchasedBrowseDatabase(database.databaseId) ? "Purchased" : nil
        ].compactMap { $0 }
        guard !badges.isEmpty else {
            return database.displayTitle
        }
        return "\(database.displayTitle) (\(badges.joined(separator: ", ")))"
    }

    private func refreshManagement() {
        model.startRefreshDatabaseManagementInfo()
        if let selectedManageDatabase {
            model.startRefreshDatabaseManagementDetails(databaseId: selectedManageDatabase.databaseId)
        }
    }
}

private struct ManageSignedOutView: View {
    @Bindable var model: AppModel

    var body: some View {
        VStack(spacing: 12) {
            ContentUnavailableView("Sign in to manage", systemImage: "person.crop.circle")

            Button("Sign in", systemImage: "person.crop.circle", action: model.startSignIn)
                .buttonStyle(.borderedProminent)
                .disabled(model.isSigningIn)

            if model.isSigningIn {
                ProgressView("Starting sign in...")
                    .font(.footnote)
            } else if let message = model.statusMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(KinicDesign.bodyGray)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(KinicDesign.screenPadding)
    }
}

#Preview {
    NavigationStack {
        ManageView(model: .preview())
    }
}
