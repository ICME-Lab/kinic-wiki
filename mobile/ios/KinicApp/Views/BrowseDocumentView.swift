// Where: mobile/ios/KinicApp/Views/BrowseDocumentView.swift
// What: Read-only document detail for a selected VFS file or source node.
// Why: iOS browsing should preview Markdown natively and still allow raw inspection.

import SwiftUI

struct BrowseDocumentView: View {
    @Bindable var model: AppModel
    let path: String
    @State private var documentMode = BrowseDocumentMode.preview

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.isLoadingDocument && model.documentNode?.path != normalizedPath {
                    ProgressView()
                        .tint(KinicDesign.hotPink)
                } else if let error = model.documentError {
                    Text(error)
                        .foregroundStyle(.red)
                } else if let node = model.documentNode,
                          node.path == normalizedPath {
                    BrowseDocumentContent(node: node, mode: documentMode)
                } else {
                    ContentUnavailableView("Select a note", systemImage: "doc.text")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(KinicDesign.screenPadding)
        }
        .background(.white)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu("View", systemImage: "ellipsis.circle") {
                    Picker("View", selection: $documentMode) {
                        ForEach(BrowseDocumentMode.allCases) { mode in
                            Text(mode.rawValue).tag(mode)
                        }
                    }
                }
            }
        }
        .task(id: normalizedPath) {
            model.startLoadBrowseDocument(normalizedPath)
        }
    }

    private var normalizedPath: String {
        AppModel.normalizedBrowsePath(path)
    }

    private var title: String {
        normalizedPath.split(separator: "/").last.map(String.init) ?? normalizedPath
    }
}
