// Where: mobile/ios/KinicApp/Views/SettingsView.swift
// What: Database management surface for the selected readable wiki database.
// Why: Browse should stay focused on reading, while Settings owns database configuration.

import SwiftUI

struct SettingsView: View {
    @Bindable var model: AppModel

    var body: some View {
        Group {
            if model.isSignedIn {
                Form {
                    databasePickerSection

                    if let database = selectedSettingsDatabase {
                        DatabaseManagementFormContent(model: model, database: database)
                    } else if !model.isLoadingDatabases {
                        Section("Management") {
                            Text("No readable database selected.")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                BrowseSignedOutView(model: model)
            }
        }
        .navigationTitle("Settings")
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
            if model.isLoadingDatabases && model.readableDatabases.isEmpty {
                ProgressView()
                    .tint(KinicDesign.hotPink)
            } else if model.readableDatabases.isEmpty {
                Text("No readable databases.")
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 12) {
                    Picker("Database", selection: $model.selectedBrowseDatabaseId) {
                        ForEach(model.readableDatabases) { database in
                            Text(database.displayTitle)
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

    private var selectedSettingsDatabase: DatabaseSummary? {
        model.readableDatabases.first { $0.databaseId == model.selectedBrowseDatabaseId }
    }

    private func refreshManagement() {
        model.startRefreshDatabaseManagementInfo()
        if !model.selectedBrowseDatabaseId.isEmpty {
            model.startRefreshDatabaseManagementDetails(databaseId: model.selectedBrowseDatabaseId)
        }
    }
}

#Preview {
    NavigationStack {
        SettingsView(model: .preview())
    }
}
