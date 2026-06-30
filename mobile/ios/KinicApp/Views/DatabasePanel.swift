// Where: mobile/ios/KinicApp/Views/DatabasePanel.swift
// What: Writable database selector for source capture.
// Why: Shared URLs must be written into a user-selected Kinic Wiki database.

import SwiftUI

struct DatabasePanel: View {
    @Bindable var model: AppModel

    var body: some View {
        KinicPanel(title: "Database", systemImage: "externaldrive") {
            VStack(alignment: .leading, spacing: 14) {
                if model.databases.isEmpty {
                    ContentUnavailableView(
                        model.isSignedIn ? "No writable databases" : "Sign in to load databases",
                        systemImage: "externaldrive",
                        description: Text(model.isSignedIn ? "Owner and Writer databases appear here." : "Internet Identity unlocks your writable databases.")
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    Picker("Target", selection: $model.selectedDatabaseId) {
                        ForEach(model.databases) { database in
                            Text("\(database.displayTitle) (\(database.role.displayName))")
                                .tag(database.databaseId)
                        }
                    }
                    .pickerStyle(.menu)
                    .tint(KinicDesign.hotPink)
                    .onChange(of: model.selectedDatabaseId) {
                        model.selectDatabase(model.selectedDatabaseId)
                    }

                    if let database = model.selectedDatabase {
                        Text(database.databaseId)
                            .font(.footnote)
                            .foregroundStyle(KinicDesign.bodyGray)
                            .lineLimit(2)
                    }
                }

                Button(model.isLoadingDatabases ? "Refreshing databases" : "Refresh databases", systemImage: "arrow.clockwise", action: model.startRefreshDatabases)
                    .buttonStyle(KinicSecondaryButtonStyle())
                    .disabled(!model.isSignedIn || model.isLoadingDatabases)
            }
        }
    }
}

#Preview {
    DatabasePanel(model: .preview())
        .padding()
}
