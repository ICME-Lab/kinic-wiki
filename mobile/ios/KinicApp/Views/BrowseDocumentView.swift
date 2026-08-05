// Where: mobile/ios/KinicApp/Views/BrowseDocumentView.swift
// What: Read-only document detail with native page sharing, publication, export, and deletion actions.
// Why: Page-level actions belong beside the existing Preview/Raw control without exposing unrelated database content.

import SafariServices
import SwiftUI
import UIKit

struct BrowseDocumentView: View {
    @Bindable var model: AppModel
    let path: String
    @State private var documentMode = BrowseDocumentMode.preview
    @State private var pendingConfirmation: BrowseDocumentConfirmation?
    @State private var isPublicPreviewPresented = false
    @State private var feedbackMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.isLoadingDocument && model.documentNode?.path != normalizedPath {
                    ProgressView()
                        .tint(KinicDesign.hotPink)
                } else if let error = model.documentError {
                    Text(error)
                        .foregroundStyle(.red)
                } else if let node = currentNode {
                    BrowseDocumentContent(node: node, mode: documentMode)
                } else {
                    ContentUnavailableView("Select a node", systemImage: "doc.text")
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
                documentMenu
            }
        }
        .overlay(alignment: .bottom) {
            if let feedbackMessage {
                Text(feedbackMessage)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.black.opacity(0.82), in: Capsule())
                    .padding(.bottom, 18)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: feedbackMessage)
        .confirmationDialog(
            pendingConfirmation?.title ?? "Confirm action",
            isPresented: confirmationPresented,
            titleVisibility: .visible
        ) {
            confirmationButtons
        } message: {
            if let pendingConfirmation {
                Text(pendingConfirmation.message(path: normalizedPath, isPublished: publication != nil))
            }
        }
        .alert("Document action failed", isPresented: actionErrorPresented) {
            Button("OK", role: .cancel) {
                model.clearBrowseDocumentActionError()
            }
        } message: {
            Text(model.documentActionError ?? "The action could not be completed.")
        }
        .sheet(isPresented: $isPublicPreviewPresented) {
            if let publicURL {
                SafariView(url: publicURL)
                    .ignoresSafeArea()
            }
        }
        .task(id: normalizedPath) {
            model.startLoadBrowseDocument(normalizedPath)
        }
        .onDisappear {
            model.leaveBrowseDocument(normalizedPath)
        }
    }

    private var documentMenu: some View {
        Menu("Document actions", systemImage: "ellipsis.circle") {
            Section("View") {
                Picker("View", selection: $documentMode) {
                    ForEach(BrowseDocumentMode.allCases) { mode in
                        Text(mode.rawValue).tag(mode)
                    }
                }
            }

            if let node = currentNode, isMarkdownPage(node) {
                shareSection(node: node)
                publicationSection
                deleteSection
            }
        }
        .disabled(currentNode == nil)
    }

    @ViewBuilder
    private func shareSection(node: VFSNode) -> some View {
        Section("Share") {
            if let publicURL {
                Button("Copy Public Link", systemImage: "link") {
                    copy(publicURL, feedback: "Public link copied")
                }
                ShareLink(item: publicURL) {
                    Label("Share Public Link", systemImage: "square.and.arrow.up")
                }
                Button("Copy Database Link", systemImage: "link.badge.plus") {
                    copy(databaseURL, feedback: "Database link copied")
                }
                Button("Open Published Page", systemImage: "safari") {
                    isPublicPreviewPresented = true
                }
            } else {
                Button("Copy Page Link", systemImage: "link") {
                    copy(databaseURL, feedback: "Page link copied")
                }
                ShareLink(item: databaseURL) {
                    Label("Share Page Link", systemImage: "square.and.arrow.up")
                }
            }

            ShareLink(
                item: MarkdownExportItem(fileName: exportFileName, content: node.content),
                preview: SharePreview(exportFileName)
            ) {
                Label("Export Markdown", systemImage: "doc.badge.arrow.up")
            }

            if case .loading = model.documentPublicationState,
               !model.canPublishBrowseDocument(normalizedPath) {
                Label("Checking Publication", systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            } else if case .failed = model.documentPublicationState,
                      !model.canPublishBrowseDocument(normalizedPath) {
                Button("Retry Publication Status", systemImage: "arrow.clockwise") {
                    model.startLoadBrowseDocument(normalizedPath)
                }
            }
        }
        .disabled(model.documentMutation != nil)
    }

    @ViewBuilder
    private var publicationSection: some View {
        if model.canPublishBrowseDocument(normalizedPath) {
            Section("Publication") {
                switch model.documentPublicationState {
                case .unpublished:
                    Button("Publish", systemImage: "globe") {
                        pendingConfirmation = .publish
                    }
                case .published:
                    Button("Unpublish", systemImage: "globe.badge.chevron.backward") {
                        pendingConfirmation = .unpublish
                    }
                case .loading:
                    Label("Checking Publication", systemImage: "hourglass")
                        .foregroundStyle(.secondary)
                case .failed:
                    Button("Retry Publication Status", systemImage: "arrow.clockwise") {
                        model.startLoadBrowseDocument(normalizedPath)
                    }
                case .unavailable:
                    EmptyView()
                }
            }
            .disabled(model.documentMutation != nil)
        }
    }

    @ViewBuilder
    private var deleteSection: some View {
        if model.canDeleteBrowseDocument(normalizedPath) {
            Section {
                Button("Delete Page", systemImage: "trash", role: .destructive) {
                    pendingConfirmation = .delete
                }
            }
            .disabled(model.documentMutation != nil)
        }
    }

    @ViewBuilder
    private var confirmationButtons: some View {
        switch pendingConfirmation {
        case .publish:
            Button("Publish") {
                pendingConfirmation = nil
                Task {
                    if await model.publishBrowseDocument(normalizedPath) {
                        showFeedback("Page published")
                    }
                }
            }
        case .unpublish:
            Button("Unpublish", role: .destructive) {
                pendingConfirmation = nil
                Task {
                    if await model.unpublishBrowseDocument(normalizedPath) {
                        showFeedback("Page unpublished")
                    }
                }
            }
        case .delete:
            Button("Delete Page", role: .destructive) {
                pendingConfirmation = nil
                Task {
                    _ = await model.deleteBrowseDocument(normalizedPath)
                }
            }
        case nil:
            EmptyView()
        }
        Button("Cancel", role: .cancel) {
            pendingConfirmation = nil
        }
    }

    private var confirmationPresented: Binding<Bool> {
        Binding(
            get: { pendingConfirmation != nil },
            set: { presented in
                if !presented {
                    pendingConfirmation = nil
                }
            }
        )
    }

    private var actionErrorPresented: Binding<Bool> {
        Binding(
            get: { model.documentActionError != nil },
            set: { presented in
                if !presented {
                    model.clearBrowseDocumentActionError()
                }
            }
        )
    }

    private var normalizedPath: String {
        AppModel.normalizedBrowsePath(path)
    }

    private var currentNode: VFSNode? {
        guard model.documentNode?.path == normalizedPath else {
            return nil
        }
        return model.documentNode
    }

    private var title: String {
        normalizedPath.split(separator: "/").last.map(String.init) ?? normalizedPath
    }

    private var databaseURL: URL {
        model.configuration.databaseNodeURL(databaseId: model.selectedBrowseDatabaseId, path: normalizedPath)
    }

    private var publication: NodePublication? {
        guard case .published(let publication) = model.documentPublicationState,
              publication.path == normalizedPath else {
            return nil
        }
        return publication
    }

    private var publicURL: URL? {
        publication.flatMap { model.configuration.publicNodeURL(publicId: $0.publicId) }
    }

    private var exportFileName: String {
        normalizedPath.split(separator: "/").last.map(String.init) ?? "page.md"
    }

    private func isMarkdownPage(_ node: VFSNode) -> Bool {
        node.kind == .file && node.path.hasSuffix(".md")
    }

    private func copy(_ url: URL, feedback: String) {
        UIPasteboard.general.url = url
        showFeedback(feedback)
    }

    private func showFeedback(_ message: String) {
        feedbackMessage = message
        Task {
            try? await Task.sleep(for: .seconds(2))
            if feedbackMessage == message {
                feedbackMessage = nil
            }
        }
    }
}

private enum BrowseDocumentConfirmation {
    case publish
    case unpublish
    case delete

    var title: String {
        switch self {
        case .publish:
            "Publish page?"
        case .unpublish:
            "Unpublish page?"
        case .delete:
            "Delete page permanently?"
        }
    }

    func message(path: String, isPublished: Bool) -> String {
        switch self {
        case .publish:
            "Anyone with the public link can read \(path). Future edits to this page will also be public."
        case .unpublish:
            "The current public link will stop working. Publishing this page again will create a new link."
        case .delete:
            isPublished
                ? "\(path) will be permanently deleted and its public link will stop working. This cannot be undone."
                : "\(path) will be permanently deleted. This cannot be undone."
        }
    }
}

private struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
