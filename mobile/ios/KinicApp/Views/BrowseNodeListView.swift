// Where: mobile/ios/KinicApp/Views/BrowseNodeListView.swift
// What: Folder child list and selected-DB search surface.
// Why: Browsing should feel like the iOS Notes list: folders push, documents open in detail.

import SwiftUI

struct BrowseNodeListView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var isSearchPresented = false
    @AppStorage("browseNodeSortOrder") private var sortOrder = BrowseNodeSortOrder.name
    @Bindable var model: AppModel
    let folderPath: String
    @Binding var selectedDocumentPath: String?

    var body: some View {
        List {
            if isSearching {
                BrowseSearchResultsView(
                    model: model,
                    selectedDocumentPath: $selectedDocumentPath
                )
            } else if let error = model.browseError {
                Text(error)
                    .foregroundStyle(.red)
            } else if model.loadedBrowsePath != normalizedFolderPath {
                ProgressView()
                    .tint(KinicDesign.hotPink)
            } else if visibleChildNodes.isEmpty {
                ContentUnavailableView("Empty folder", systemImage: "folder")
            } else {
                childRows
            }
        }
        .navigationTitle(model.selectedBrowseDatabase?.displayTitle ?? "Notes")
        .searchable(text: $model.searchQuery, isPresented: $isSearchPresented, prompt: "Search nodes")
        .onSubmit(of: .search, model.startSearch)
        .onChange(of: model.searchQuery) { oldQuery, newQuery in
            model.searchQueryDidChange(from: oldQuery, to: newQuery)
        }
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Menu("Sort", systemImage: "arrow.up.arrow.down") {
                    Picker("Sort by", selection: $sortOrder) {
                        ForEach(BrowseNodeSortOrder.allCases) { order in
                            Label(order.title, systemImage: order.systemImage)
                                .tag(order)
                        }
                    }
                }

                Button("Search", systemImage: "magnifyingglass", action: showSearch)
                    .disabled(!model.canBrowse)

                Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
                    .disabled(!model.canBrowse || model.isLoadingBrowsePath)
            }
        }
        .task(id: normalizedFolderPath) {
            loadFolder()
        }
    }

    private var childRows: some View {
        ForEach(visibleChildNodes) { child in
            if child.kind == .folder {
                NavigationLink(value: BrowseFolderRoute(path: child.path)) {
                    BrowseChildNodeRow(child: child)
                }
            } else {
                if horizontalSizeClass == .compact {
                    NavigationLink(value: BrowseFolderRoute.document(path: child.path)) {
                        BrowseChildNodeRow(child: child)
                    }
                } else {
                    Button(action: { openDocument(child.path) }) {
                        BrowseChildNodeRow(child: child)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var visibleChildNodes: [ChildNode] {
        let visibleNodes = model.childNodes.filter { child in
            child.kind != .folder || child.hasChildren
        }
        return sortOrder.sorted(visibleNodes)
    }

    private var isSearching: Bool {
        !model.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var normalizedFolderPath: String {
        AppModel.normalizedBrowsePath(folderPath)
    }

    private func loadFolder() {
        model.startLoadBrowsePath(normalizedFolderPath)
    }

    private func refresh() {
        model.startLoadBrowsePath(normalizedFolderPath)
    }

    private func showSearch() {
        isSearchPresented = true
    }

    private func openDocument(_ path: String) {
        selectedDocumentPath = path
        model.startLoadBrowseDocument(path)
    }
}
