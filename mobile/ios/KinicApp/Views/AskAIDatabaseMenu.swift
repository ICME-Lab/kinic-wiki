// Where: mobile/ios/KinicApp/Views/AskAIDatabaseMenu.swift
// What: Compact one-database scope selector for Ask AI.
// Why: Users must always know which database may be searched and sent to Kinic AI.

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
            Label(
                appModel.selectedAskAIDatabaseTitle.isEmpty ? "Choose database" : appModel.selectedAskAIDatabaseTitle,
                systemImage: "externaldrive"
            )
            .lineLimit(1)
        }
        .tint(KinicDesign.hotPink)
        .accessibilityHint("Selects the only database Ask AI may search")
    }
}
