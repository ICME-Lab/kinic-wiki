// Where: mobile/ios/KinicApp/Views/BrowseNodeNavigationView.swift
// What: Folder navigation stack inside the selected database column.
// Why: iPhone should push folders like Notes while iPad keeps the document in the detail column.

import SwiftUI

struct BrowseNodeNavigationView: View {
    @Bindable var model: AppModel
    let databaseId: String
    @Binding var selectedDocumentPath: String?
    @Binding var folderPath: [BrowseFolderRoute]
    @Binding var isSearchPresented: Bool
    let requestSearchFolder: (String) -> Void

    var body: some View {
        NavigationStack(path: $folderPath) {
            BrowseNodeListView(
                model: model,
                folderPath: "/",
                selectedDocumentPath: $selectedDocumentPath,
                isSearchPresented: $isSearchPresented,
                openSearchFolder: requestSearchFolder
            )
            .navigationDestination(for: BrowseFolderRoute.self) { route in
                switch route.kind {
                case .folder:
                    BrowseNodeListView(
                        model: model,
                        folderPath: route.path,
                        selectedDocumentPath: $selectedDocumentPath,
                        isSearchPresented: $isSearchPresented,
                        openSearchFolder: requestSearchFolder
                    )
                case .document:
                    BrowseDocumentView(model: model, path: route.path)
                }
            }
        }
        .id(databaseId)
    }
}
