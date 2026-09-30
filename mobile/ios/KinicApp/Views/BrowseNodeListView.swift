// Where: mobile/ios/KinicApp/Views/BrowseNodeListView.swift
// What: Folder child list and selected-DB search surface.
// Why: Browsing should feel like the iOS Notes list: folders push, documents open in detail.

import SwiftUI

struct BrowseNodeListView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @AppStorage("browseNodeSortOrder") private var sortOrder = BrowseNodeSortOrder.name
    @Bindable var model: AppModel
    let folderPath: String
    @Binding var selectedDocumentPath: String?
    @Binding var isSearchPresented: Bool
    let openSearchFolder: (String) -> Void
    var showsDatabaseContext = false
    @FocusState private var searchFocused: Bool

    var body: some View {
        List {
            if isSearching {
                BrowseSearchResultsView(
                    model: model,
                    folderPath: normalizedFolderPath,
                    selectedDocumentPath: $selectedDocumentPath,
                    openFolder: openFolderFromSearch
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
        .navigationTitle(normalizedFolderPath == "/" ? (showsDatabaseContext ? "" : "Browse") : URL(fileURLWithPath: normalizedFolderPath).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .top, spacing: 0) {
            if isSearchPresented { searchBar }
        }
        .onChange(of: isSearchPresented) { _, presented in
            searchFocused = presented
        }
        .onSubmit(of: .search) {
            model.startSearch(in: normalizedFolderPath)
            searchFocused = false
        }
        .onChange(of: model.searchQuery) { oldQuery, newQuery in
            model.searchQueryDidChange(
                from: oldQuery,
                to: newQuery,
                folderPath: normalizedFolderPath
            )
        }
        .onChange(of: model.browseSearchScope) {
            model.browseSearchScopeDidChange(folderPath: normalizedFolderPath)
        }
        .toolbar {
            if showsDatabaseContext && normalizedFolderPath == "/" {
                ToolbarItem(placement: .topBarLeading) {
                    DatabaseContextBar(model: model, compact: true)
                }
                .databaseTitleAppearance()
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button("Search", systemImage: "magnifyingglass", action: showSearch)
                    .disabled(!model.canBrowse)

                Menu("Browse actions", systemImage: "ellipsis") {
                    Picker("Sort by", selection: $sortOrder) {
                        ForEach(BrowseNodeSortOrder.allCases) { order in
                            Label(order.title, systemImage: order.systemImage)
                                .tag(order)
                        }
                    }
                    Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
                        .disabled(!model.canBrowse || model.isLoadingBrowsePath)
                }
            }
        }
        .task(id: normalizedFolderPath) {
            loadFolder()
            model.browseFolderDidBecomeActive(normalizedFolderPath)
        }
    }

    private var searchBar: some View {
        VStack(spacing: 10) {
            HStack(spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("Search nodes", text: $model.searchQuery)
                        .accessibilityIdentifier("browse.searchField")
                        .focused($searchFocused)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                    if !model.searchQuery.isEmpty {
                        Button("Clear search", systemImage: "xmark.circle.fill") { model.searchQuery = "" }
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(12)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
                Button("Cancel") {
                    searchFocused = false
                    model.searchQuery = ""
                    isSearchPresented = false
                }
                .accessibilityIdentifier("browse.cancelSearch")
            }
            Picker("Search scope", selection: $model.browseSearchScope) {
                ForEach(BrowseSearchScope.allCases) { scope in
                    Text(scope.title).tag(scope)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(.horizontal, KinicDesign.screenPadding)
        .padding(.vertical, 8)
        .background(.bar)
        .onAppear { searchFocused = true }
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
        searchFocused = true
    }

    private func openDocument(_ path: String) {
        selectedDocumentPath = path
    }

    private func openFolderFromSearch(_ path: String) {
        openSearchFolder(path)
    }
}
