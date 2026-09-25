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
                    if let database = selectedManageDatabase {
                        DatabaseManagementFormContent(model: model, database: database)
                    } else {
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
        .databaseContext(model: model)
        .refreshable { refreshManagement() }
        .navigationTitle("Manage")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            model.startRefreshDatabases()
        }
        .onChange(of: model.selectedBrowseDatabaseId) { _, databaseId in
            guard model.readableDatabases.contains(where: { $0.databaseId == databaseId }) else {
                return
            }
            model.startLoadCyclesBillingConfigIfNeeded()
        }
    }

    private var selectedManageDatabase: DatabaseSummary? {
        model.selectedBrowseDatabase
    }

    private func refreshManagement() {
        model.startRefreshDatabaseManagementInfo()
        if let selectedManageDatabase {
            model.startRefreshDatabaseManagementDetails(databaseId: selectedManageDatabase.databaseId)
        }
    }

    private func selectManageDatabase(_ databaseId: String) {
        _ = model.requestBrowseDatabaseSelection(databaseId)
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
                ProgressView()
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
