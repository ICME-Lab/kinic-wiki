// Where: mobile/ios/KinicApp/Views/AskAIDatabaseMenu.swift
// What: Left-aligned Ask AI database selector with its current selection in the button label.
// Why: Users must be able to discover DB selection and see which database Ask AI may search.

import SwiftUI

struct AskAIDatabaseMenu: View {
    @Bindable var model: AskAIModel
    @Bindable var appModel: AppModel

    var body: some View {
        Menu {
            if appModel.askAIDatabaseCandidates.isEmpty {
                Text("No readable databases")
            } else {
                ForEach(appModel.askAIDatabaseCandidates) { database in
                    Button {
                        model.requestDatabaseChange(
                            databaseId: database.databaseId,
                            title: database.displayTitle
                        )
                    } label: {
                        if database.databaseId == appModel.selectedAskAIDatabaseId {
                            Label(database.displayTitle, systemImage: "checkmark")
                        } else {
                            Text(database.displayTitle)
                        }
                    }
                }
            }
        } label: {
            Text(selectedDatabaseTitle)
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .tint(KinicDesign.hotPink)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint("Selects the database Ask AI may search")
        .frame(maxWidth: 180, alignment: .leading)
    }

    private var selectedDatabaseTitle: String {
        appModel.selectedAskAIDatabaseTitle.isEmpty
            ? "Select DB"
            : appModel.selectedAskAIDatabaseTitle
    }

    private var accessibilityLabel: String {
        appModel.selectedAskAIDatabaseTitle.isEmpty
            ? "Select database"
            : "Database: \(appModel.selectedAskAIDatabaseTitle)"
    }
}
