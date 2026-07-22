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
            HStack(spacing: 8) {
                Button(model.isCreatingDatabase ? "Creating database" : "Create database", systemImage: "plus", action: presentCreateSheet)
                    .labelStyle(.iconOnly)
                    .buttonStyle(KinicIconButtonStyle())
                    .accessibilityLabel(model.isCreatingDatabase ? "Creating database" : "Create database")
                    .disabled(!model.isSignedIn || model.isLoadingDatabases || model.isCreatingDatabase)

                Button("Refresh databases", systemImage: "arrow.clockwise", action: model.startRefreshDatabases)
                    .labelStyle(.iconOnly)
                    .buttonStyle(KinicIconButtonStyle())
                    .accessibilityLabel("Refresh databases")
                    .disabled(!model.isSignedIn || model.isLoadingDatabases || model.isCreatingDatabase)
            }
        } content: {
            VStack(alignment: .leading, spacing: 14) {
                if model.captureDatabaseCandidates.isEmpty {
                    ContentUnavailableView(
                        model.isSignedIn ? "No writable databases" : "Sign in to load databases",
                        systemImage: "externaldrive",
                        description: Text(model.isSignedIn ? "Create a database or refresh existing Owner and Writer databases." : "Internet Identity unlocks your writable databases.")
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(model.captureDatabaseCandidates) { database in
                            databaseButton(database)
                        }
                    }
                }
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
        .sheet(item: $model.pendingDatabaseActivation) { activation in
            PendingDatabaseFundingSheet(
                activation: activation,
                onFundingPageReturned: model.startRefreshDatabases
            )
            .presentationDetents([.medium, .large])
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

    private func databaseButton(_ database: DatabaseSummary) -> some View {
        let isSelected = model.selectedDatabaseId == database.databaseId
        let isPending = database.status == .pending
        return Button {
            if isPending {
                model.presentFunding(for: database)
            } else {
                model.selectDatabase(database.databaseId)
            }
        } label: {
            HStack(alignment: .center, spacing: 10) {
                BrowseDatabaseRow(
                    database: database,
                    isSelected: isSelected,
                    isPublicReadable: model.isPublicBrowseDatabase(database.databaseId),
                    isPurchased: model.isPurchasedBrowseDatabase(database.databaseId)
                )
                    .frame(maxWidth: .infinity, alignment: .leading)

                Image(systemName: isPending ? "arrow.up.right.square" : isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.headline)
                    .foregroundStyle(isSelected || isPending ? KinicDesign.hotPink : KinicDesign.bodyGray)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: KinicDesign.radius)
                    .fill(isSelected ? KinicDesign.hotPink.opacity(0.08) : KinicDesign.controlBackground)
            }
            .overlay {
                RoundedRectangle(cornerRadius: KinicDesign.radius)
                    .stroke(isSelected ? KinicDesign.hotPink.opacity(0.35) : .primary.opacity(0.08), lineWidth: 0.5)
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.databaseAccessibilityLabel(
            database,
            isPublicReadable: model.isPublicBrowseDatabase(database.databaseId),
            isPurchased: model.isPurchasedBrowseDatabase(database.databaseId)
        ))
        .accessibilityValue(Self.databaseAccessibilityValue(database, isSelected: isSelected))
        .accessibilityHint(Self.databaseAccessibilityHint(database))
    }

    nonisolated static func databaseAccessibilityLabel(
        _ database: DatabaseSummary,
        isPublicReadable: Bool,
        isPurchased: Bool
    ) -> String {
        let badges = [
            database.status == .pending ? "Pending" : nil,
            isPublicReadable ? "Public" : nil,
            isPurchased ? "Purchased" : nil
        ].compactMap { $0 }
        let badgeText = badges.isEmpty ? "" : ", \(badges.joined(separator: ", "))"
        return "\(database.displayTitle), \(database.role.displayName)\(badgeText)"
    }

    nonisolated static func databaseAccessibilityValue(_ database: DatabaseSummary, isSelected: Bool) -> String {
        database.status == .pending ? "Pending activation" : isSelected ? "Selected" : "Not selected"
    }

    nonisolated static func databaseAccessibilityHint(_ database: DatabaseSummary) -> String {
        database.status == .pending ? "Opens the web funding options" : "Sets the source capture database"
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
