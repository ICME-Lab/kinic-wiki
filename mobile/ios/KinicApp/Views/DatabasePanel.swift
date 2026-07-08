// Where: mobile/ios/KinicApp/Views/DatabasePanel.swift
// What: Writable database selector for source capture.
// Why: Shared URLs must be written into a user-selected Kinic Wiki database.

import SwiftUI

struct DatabasePanel: View {
    @Bindable var model: AppModel
    @State private var isCreateSheetPresented = false
    @State private var newDatabaseName = ""

    var body: some View {
        KinicPanel(title: "Database", systemImage: "externaldrive") {
            VStack(alignment: .leading, spacing: 14) {
                if model.databases.isEmpty {
                    ContentUnavailableView(
                        model.isSignedIn ? "No writable databases" : "Sign in to load databases",
                        systemImage: "externaldrive",
                        description: Text(model.isSignedIn ? "Create a database or refresh existing Owner and Writer databases." : "Internet Identity unlocks your writable databases.")
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    HStack(alignment: .center, spacing: 8) {
                        Picker("Target", selection: $model.selectedDatabaseId) {
                            ForEach(model.databases) { database in
                                Text("\(database.displayTitle) (\(database.role.displayName))")
                                    .tag(database.databaseId)
                            }
                        }
                        .pickerStyle(.menu)
                        .tint(KinicDesign.hotPink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .onChange(of: model.selectedDatabaseId) {
                            model.selectDatabase(model.selectedDatabaseId)
                        }

                        Button("Refresh databases", systemImage: "arrow.clockwise", action: model.startRefreshDatabases)
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                            .foregroundStyle(KinicDesign.hotPink)
                            .frame(minWidth: 44, minHeight: 44)
                            .accessibilityLabel("Refresh databases")
                            .disabled(!model.isSignedIn || model.isLoadingDatabases || model.isCreatingDatabase)
                    }

                    if let database = model.selectedDatabase {
                        Text(database.databaseId)
                            .font(.footnote)
                            .foregroundStyle(KinicDesign.bodyGray)
                            .lineLimit(2)
                    }
                }

                Button(model.isCreatingDatabase ? "Creating database" : "Create database", systemImage: "plus", action: presentCreateSheet)
                    .labelStyle(.iconOnly)
                    .buttonStyle(KinicSecondaryButtonStyle())
                    .accessibilityLabel(model.isCreatingDatabase ? "Creating database" : "Create database")
                    .disabled(!model.isSignedIn || model.isLoadingDatabases || model.isCreatingDatabase)
            }
        }
        .sheet(isPresented: $isCreateSheetPresented) {
            CreateDatabaseSheet(
                databaseName: $newDatabaseName,
                creating: model.isCreatingDatabase,
                onCancel: dismissCreateSheet,
                onCreate: createDatabase
            )
            .presentationDetents([.medium])
        }
    }

    private func presentCreateSheet() {
        newDatabaseName = ""
        isCreateSheetPresented = true
    }

    private func dismissCreateSheet() {
        guard !model.isCreatingDatabase else {
            return
        }
        isCreateSheetPresented = false
    }

    private func createDatabase() {
        let trimmedName = newDatabaseName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard AppModel.databaseNameError(trimmedName) == nil else {
            model.startCreateDatabase(name: newDatabaseName)
            return
        }
        isCreateSheetPresented = false
        model.startCreateDatabase(name: newDatabaseName)
    }
}

private struct CreateDatabaseSheet: View {
    @Binding var databaseName: String
    let creating: Bool
    let onCancel: () -> Void
    let onCreate: () -> Void

    private var trimmedName: String {
        databaseName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var validationError: String? {
        AppModel.databaseNameError(trimmedName)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Team skills", text: $databaseName)
                        .textInputAutocapitalization(.words)
                        .disabled(creating)
                } header: {
                    Text("Database name")
                } footer: {
                    Text("Use 1..80 characters. The name can be changed later.")
                }

                if !trimmedName.isEmpty,
                   let validationError {
                    Section {
                        Text(validationError)
                            .foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Create database")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(creating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(creating ? "Creating..." : "Create", action: onCreate)
                        .disabled(creating || validationError != nil)
                }
            }
        }
    }
}

#Preview {
    DatabasePanel(model: .preview())
        .padding()
}
