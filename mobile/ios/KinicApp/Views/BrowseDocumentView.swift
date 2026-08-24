// Where: mobile/ios/KinicApp/Views/BrowseDocumentView.swift
// What: Document detail with Markdown editing, sharing, publication, export, and deletion actions.
// Why: Page-level editing and actions belong beside the existing Preview/Raw control.

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
    @State private var isConfirmingEditDiscard = false
    @State private var isShowingEditConflict = false
    @State private var saveErrorMessage: String?

    var body: some View {
        documentBody
        .background(.white)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isEditing {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel", action: requestCancelEditing)
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(isSaving ? "Saving…" : "Save", action: saveDocument)
                        .disabled(!canSave)
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    documentMenu
                }
            }
        }
        .navigationBarBackButtonHidden(isEditing)
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
        .alert("Save failed", isPresented: saveErrorPresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveErrorMessage ?? "The document could not be saved.")
        }
        .confirmationDialog(
            "Discard unsaved changes?",
            isPresented: $isConfirmingEditDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive, action: discardEdits)
            Button("Continue Editing", role: .cancel) {}
        } message: {
            Text("Your Markdown changes have not been saved.")
        }
        .confirmationDialog(
            "Document changed elsewhere",
            isPresented: $isShowingEditConflict,
            titleVisibility: .visible
        ) {
            Button("Copy Draft", action: copyDraft)
            Button("Discard Draft and Reload", role: .destructive, action: discardAndReload)
            Button("Continue Editing", role: .cancel) {}
        } message: {
            Text("Your draft was kept. Copy it before reloading if you want to merge it with the latest version.")
        }
        .sheet(isPresented: $isPublicPreviewPresented) {
            if let publicURL {
                SafariView(url: publicURL)
                    .ignoresSafeArea()
            }
        }
        .task(id: normalizedPath) {
            if model.documentEditSession?.path == normalizedPath,
               model.documentEditSession?.databaseId == model.selectedBrowseDatabaseId {
                documentMode = .edit
            } else {
                model.startLoadBrowseDocument(normalizedPath)
            }
        }
        .onDisappear {
            if model.documentEditSession?.path != normalizedPath {
                model.leaveBrowseDocument(normalizedPath)
            }
        }
    }

    @ViewBuilder
    private var documentBody: some View {
        if isEditing, let editSession = currentEditSession {
            VStack(alignment: .leading, spacing: 12) {
                if let editRestrictionMessage {
                    Label(editRestrictionMessage, systemImage: "lock.trianglebadge.exclamationmark")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.orange)
                        .accessibilityAddTraits(.isStaticText)
                }
                if case .conflict = editSession.state {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Label("This document changed elsewhere.", systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.orange)
                        Spacer()
                        Button("Resolve") {
                            isShowingEditConflict = true
                        }
                    }
                }
                TextEditor(text: draftBinding)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.sentences)
                    .scrollContentBackground(.hidden)
                    .disabled(isSaving)
                    .accessibilityLabel("Markdown editor")
            }
            .padding(KinicDesign.screenPadding)
        } else {
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
        }
    }

    private var documentMenu: some View {
        Menu("Document actions", systemImage: "ellipsis.circle") {
            Section("View") {
                Picker("View", selection: documentModeBinding) {
                    ForEach(availableDocumentModes) { mode in
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

    private var availableDocumentModes: [BrowseDocumentMode] {
        model.canEditBrowseDocument(normalizedPath) ? BrowseDocumentMode.allCases : [.preview, .raw]
    }

    private var documentModeBinding: Binding<BrowseDocumentMode> {
        Binding(
            get: { documentMode },
            set: { mode in
                if mode == .edit {
                    if model.startEditingBrowseDocument(normalizedPath) {
                        documentMode = .edit
                    }
                } else {
                    documentMode = mode
                }
            }
        )
    }

    private var currentEditSession: BrowseDocumentEditSession? {
        guard let editSession = model.documentEditSession,
              editSession.databaseId == model.selectedBrowseDatabaseId,
              editSession.path == normalizedPath else {
            return nil
        }
        return editSession
    }

    private var isEditing: Bool {
        documentMode == .edit && currentEditSession != nil
    }

    private var isSaving: Bool {
        currentEditSession?.state == .saving
    }

    private var canSave: Bool {
        guard let editSession = currentEditSession else { return false }
        return editSession.hasChanges
            && editSession.state == .editing
            && model.documentMutation == nil
            && model.canEditBrowseDocument(normalizedPath)
            && editRestrictionMessage == nil
    }

    private var editRestrictionMessage: String? {
        model.browseDocumentEditRestrictionMessage(normalizedPath)
    }

    private var draftBinding: Binding<String> {
        Binding(
            get: { currentEditSession?.draftContent ?? "" },
            set: { content in model.updateBrowseDocumentDraft(content) }
        )
    }

    private var saveErrorPresented: Binding<Bool> {
        Binding(
            get: { saveErrorMessage != nil },
            set: { presented in
                if !presented {
                    saveErrorMessage = nil
                }
            }
        )
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

    private func requestCancelEditing() {
        if currentEditSession?.hasChanges == true {
            isConfirmingEditDiscard = true
        } else {
            discardEdits()
        }
    }

    private func discardEdits() {
        model.discardBrowseDocumentEdits()
        documentMode = .preview
    }

    private func saveDocument() {
        Task {
            switch await model.saveBrowseDocument() {
            case .saved:
                documentMode = .preview
                showFeedback("Document saved")
            case .conflict:
                isShowingEditConflict = true
            case .failed(let message):
                saveErrorMessage = message
            case .stale:
                break
            }
        }
    }

    private func copyDraft() {
        UIPasteboard.general.string = currentEditSession?.draftContent
        showFeedback("Draft copied")
    }

    private func discardAndReload() {
        model.discardBrowseDocumentEdits()
        documentMode = .preview
        model.startLoadBrowseDocument(normalizedPath)
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
