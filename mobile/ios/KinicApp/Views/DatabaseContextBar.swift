// Shared database context and app settings for the four root surfaces.
import SwiftUI

private struct OpenKinicSettingsKey: EnvironmentKey {
    static let defaultValue: @MainActor () -> Void = {}
}

extension EnvironmentValues {
    var openKinicSettings: @MainActor () -> Void {
        get { self[OpenKinicSettingsKey.self] }
        set { self[OpenKinicSettingsKey.self] = newValue }
    }
}

struct DatabaseContextBar: View {
    @Bindable var model: AppModel
    var askAIModel: AskAIModel? = nil
    @Environment(\.openKinicSettings) private var openSettings
    @State private var isChoosingDatabase = false
    @State private var pendingSelection: DatabaseSummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 12) {
                Button {
                    isChoosingDatabase = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "externaldrive")
                        Text(model.selectedDatabase?.displayTitle ?? "Select a database")
                            .font(.headline)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        Image(systemName: "chevron.down").font(.caption.weight(.semibold))
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("database.choose")
                .accessibilityLabel("Choose database")
                .accessibilityValue(model.selectedDatabase?.displayTitle ?? "No database selected")

                Button("Settings", systemImage: "gearshape", action: openSettings)
                    .labelStyle(.iconOnly)
                    .frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("app.settings")
            }
            if model.databaseSelectionLocked {
                Text(model.databaseSelectionLockReason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.vertical, 6)
        .background(.bar)
        .sheet(isPresented: $isChoosingDatabase, onDismiss: applySelection) {
            DatabaseSelectionSheet(model: model, databases: askAIModel == nil ? model.browseListDatabases : model.askAIDatabaseCandidates) { database in
                pendingSelection = database
                isChoosingDatabase = false
            }
        }
        .onChange(of: model.principalText) {
            pendingSelection = nil
            isChoosingDatabase = false
        }
    }

    // Present confirmations only after the picker has finished dismissing.
    private func applySelection() {
        guard let database = pendingSelection else { return }
        pendingSelection = nil
        if let askAIModel {
            askAIModel.requestDatabaseChange(databaseId: database.databaseId, title: database.displayTitle)
        } else {
            _ = model.requestBrowseDatabaseSelection(database.databaseId)
        }
    }
}

struct DatabaseSelectionSheet: View {
    @Bindable var model: AppModel
    let databases: [DatabaseSummary]
    let onSelect: (DatabaseSummary) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                DatabasePanel(model: model, databases: databases, searchQuery: query, onSelect: onSelect)
                    .padding(KinicDesign.screenPadding)
            }
            .background(KinicDesign.appBackground)
            .navigationTitle("Databases")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search databases")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.frame(minHeight: 44)
                }
            }
        }
    }
}

extension View {
    func databaseContext(model: AppModel, askAIModel: AskAIModel? = nil) -> some View {
        safeAreaInset(edge: .top, spacing: 0) {
            DatabaseContextBar(model: model, askAIModel: askAIModel)
        }
    }
}
