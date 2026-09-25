// Where: mobile/ios/KinicApp/Views/WorkItemDetailView.swift
// What: Reads one work item, its comments, and its source link, and edits it in place.
// Why: The body, the state, and their metadata must only be written together under the loaded etag.

import SwiftUI

struct WorkItemDetailView: View {
    @Bindable var model: WorkItemModel
    @Bindable var appModel: AppModel
    let itemId: String

    @State private var detail: WorkItemDetail?
    @State private var loadState: LoadState = .loading
    @State private var isEditing = false
    @State private var draftTitle = ""
    @State private var draftBody = ""
    @State private var commentDraft = ""
    @State private var isShowingConflict = false
    @State private var sourceOpenError: String?
    @Environment(\.dismiss) private var dismiss
    @State private var draftOwner = UUID()
    @State private var discardIntent: DiscardIntent?
    @State private var discardMutation: WorkItemPendingMutation?
    @FocusState private var focusedField: InputField?
    private enum InputField { case title, body, comment }
    private enum DiscardIntent { case leave, edit }
    private var hasUnsavedInput: Bool {
        !commentDraft.isEmpty || (isEditing && (draftTitle != detail?.item.title || draftBody != detail?.item.body))
    }
    private var locksDatabase: Bool { hasUnsavedInput || model.isSaving || model.isPostingComment }


    private enum LoadState: Equatable {
        case loading
        case ready
        case missing
        case failed(String)
    }

    private var pendingForItem: [WorkItemPendingMutation] {
        model.pendingMutations.filter { $0.itemId == itemId }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch loadState {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                case .missing:
                    StatusPanel(message: "This work item no longer exists.")
                case .failed(let message):
                    StatusPanel(message: message)
                case .ready:
                    if let detail {
                        header(detail)
                        bodySection(detail)
                        if let source = detail.item.source {
                            sourcePanel(source)
                        }
                        if !pendingForItem.isEmpty {
                            pendingPanel
                        }
                        commentsSection(detail)
                    }
                }

                if let message = model.actionError {
                    StatusPanel(message: message)
                }
            }
            .padding(KinicDesign.screenPadding)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(KinicDesign.appBackground)
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .navigationBarBackButtonHidden(locksDatabase)
        .onChange(of: locksDatabase, initial: true) { _, active in
            appModel.setWorkItemDraftActive(active, owner: draftOwner)
        }
        .alert("Discard unsaved changes?", isPresented: Binding(get: { discardIntent != nil }, set: { if !$0 { discardIntent = nil } }), presenting: discardIntent) { intent in
            Button("Discard changes", role: .destructive) {
                discardIntent = nil
                cancelEditing()
                if intent == .leave {
                    commentDraft = ""
                    appModel.setWorkItemDraftActive(false, owner: draftOwner)
                    dismiss()
                }
            }
            Button("Keep editing", role: .cancel) { discardIntent = nil }
        }
        .alert("Discard these unsent changes?", isPresented: Binding(get: { discardMutation != nil }, set: { if !$0 { discardMutation = nil } }), presenting: discardMutation) { mutation in
            Button("Discard changes", role: .destructive) { model.discardPendingMutation(mutation.mutationId) }
            Button("Keep changes", role: .cancel) {}
        }
        .task {
            await load()
            await model.loadComments(itemId)
        }
        .onChange(of: model.conflict) { _, conflict in
            isShowingConflict = conflict != nil
        }
        .sheet(isPresented: $isShowingConflict) {
            conflictSheet
        }
    }

    private var navigationTitle: String {
        guard let detail, !detail.isUnsupportedVersion else { return "Item" }
        return detail.item.title.isEmpty ? "Item" : detail.item.title
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") { focusedField = nil }
                .accessibilityIdentifier("keyboard.done")
        }
        if locksDatabase {
            ToolbarItem(placement: .topBarLeading) {
                Button("Back", systemImage: "chevron.left") { discardIntent = .leave }
                    .disabled(model.isSaving || model.isPostingComment)
            }
        }
        if let detail, !detail.isUnsupportedVersion, model.canWrite {
            if isEditing {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Save") { save(detail) }
                        .tint(KinicDesign.hotPink)
                        .disabled(draftTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSaving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") {
                        if draftTitle != detail.item.title || draftBody != detail.item.body { discardIntent = .edit }
                        else { cancelEditing() }
                    }.disabled(model.isSaving)
                        .tint(KinicDesign.hotPink)
                }
            } else {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(detail.item.state == .open ? "Close" : "Reopen") {
                        Task { await changeState(detail) }
                    }
                    .tint(KinicDesign.hotPink)
                    .disabled(model.isSaving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { beginEditing(detail) }
                        .tint(KinicDesign.hotPink)
                }
            }
        }
    }

    @ViewBuilder
    private func header(_ detail: WorkItemDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(appModel.selectedDatabase?.displayTitle ?? appModel.selectedDatabaseId, systemImage: "externaldrive")
                .font(.subheadline).foregroundStyle(.secondary)
            if detail.isUnsupportedVersion {
                Text("This item was written by a newer version of the app. The body is shown read-only.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else if isEditing {
                TextField("Title", text: $draftTitle)
                    .focused($focusedField, equals: .title)
                    .textFieldStyle(.roundedBorder)
                    .font(.headline)
            } else {
                Text(detail.item.title)
                    .font(.title3.weight(.semibold))
            }

            HStack(spacing: 10) {
                Label(detail.item.state.displayName, systemImage: detail.item.state == .open ? "circle" : "checkmark.circle.fill")
                Label("\(detail.commentCount)", systemImage: "bubble.left")
                Text("Updated \(WorkItemListView.date(fromMilliseconds: detail.item.updatedAt).formatted(.relative(presentation: .named)))")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if !model.canWrite {
                Text("Read-only access to this database.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func bodySection(_ detail: WorkItemDetail) -> some View {
        if isEditing {
            TextEditor(text: $draftBody)
                .focused($focusedField, equals: .body)
                .frame(minHeight: 240)
                .padding(12)
                .scrollContentBackground(.hidden)
                .background(KinicDesign.controlBackground, in: RoundedRectangle(cornerRadius: KinicDesign.radius))
                .overlay {
                    RoundedRectangle(cornerRadius: KinicDesign.radius)
                        .stroke(KinicDesign.hairlineGray, lineWidth: 1)
                }
                .accessibilityLabel("Work item body")
        } else {
            MarkdownContent(markdown: detail.item.body)
        }
    }

    @ViewBuilder
    private func sourcePanel(_ source: WorkItemSource) -> some View {
        KinicPanel(title: "Source", systemImage: "link") {
            VStack(alignment: .leading, spacing: 6) {
                if let label = source.label, !label.isEmpty {
                    Text(label)
                        .font(.body)
                }
                if let path = source.path, !path.isEmpty {
                    Button("Open in Browse", systemImage: "book") {
                        openSourceDocument(path: path)
                    }
                    .font(.footnote)
                    .tint(KinicDesign.hotPink)
                }
                if let urlString = source.url, let url = URL(string: urlString) {
                    Link(destination: url) {
                        Label(urlString, systemImage: "arrow.up.right.square")
                            .font(.footnote)
                    }
                    .tint(KinicDesign.hotPink)
                } else if let path = source.path {
                    Text(path)
                        .font(.footnote.monospaced())
                        .textSelection(.enabled)
                        .foregroundStyle(.secondary)
                }
                if let sourceOpenError {
                    Text(sourceOpenError)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// The body stays readable even when the page it came from is gone or no longer shared with us.
    private func openSourceDocument(path: String) {
        guard let databaseId = model.databaseId else {
            sourceOpenError = "Could not open this page (no database is selected)."
            return
        }
        if appModel.openWikiDocument(databaseId: databaseId, path: path) {
            sourceOpenError = nil
        } else {
            sourceOpenError = "Could not open this page (it was deleted or you no longer have access)."
        }
    }

    @ViewBuilder
    private func commentsSection(_ detail: WorkItemDetail) -> some View {
        KinicPanel(title: "Comments", systemImage: "bubble.left") {
            VStack(alignment: .leading, spacing: 14) {
                if model.isLoadingComments && model.comments.isEmpty {
                    ProgressView()
                } else if model.comments.isEmpty {
                    Text("No comments yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(model.comments) { comment in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(Self.authorLabel(comment.author))
                                    .font(.caption.weight(.semibold))
                                Spacer()
                                Text(WorkItemListView.date(fromMilliseconds: comment.createdAt).formatted(.relative(presentation: .named)))
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                            MarkdownContent(markdown: comment.body)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }

                if detail.commentCount > model.comments.count {
                    Text("\(detail.commentCount - model.comments.count) older comment(s) are not shown.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if model.canWrite && !detail.isUnsupportedVersion {
                    TextField("Add a comment", text: $commentDraft, axis: .vertical)
                        .focused($focusedField, equals: .comment)
                        .lineLimit(1...6)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("New comment")

                    Button {
                        Task { await postComment() }
                    } label: {
                        Label(model.isPostingComment ? "Posting…" : "Post comment", systemImage: "paperplane")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(KinicDesign.hotPink)
                    .disabled(
                        commentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || model.isPostingComment
                    )
                }
            }
        }
    }

    private var pendingPanel: some View {
        KinicPanel(title: "Unsent changes", systemImage: "exclamationmark.arrow.triangle.2.circlepath") {
            VStack(alignment: .leading, spacing: 10) {
                Text("These changes are saved on this device only. They are not in the database yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                ForEach(pendingForItem) { mutation in
                    HStack(spacing: 12) {
                        Text(mutation.kind.displayName)
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Button("Send") {
                            Task {
                                await model.retryPendingMutation(mutation)
                                await load()
                                await model.loadComments(itemId)
                            }
                        }
                        Button("Discard", role: .destructive) {
                            discardMutation = mutation
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var conflictSheet: some View {
        if let conflict = model.conflict {
            NavigationStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Text("Another member saved this item first. Nothing was overwritten.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        KinicPanel(title: "Latest version", systemImage: "clock.arrow.circlepath") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(conflict.latest.item.title)
                                    .font(.headline)
                                MarkdownContent(markdown: conflict.latest.item.body)
                            }
                        }

                        KinicPanel(title: "Your version", systemImage: "pencil") {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(conflict.mine.title)
                                    .font(.headline)
                                MarkdownContent(markdown: conflict.mine.body)
                            }
                        }
                    }
                    .padding(KinicDesign.screenPadding)
                }
                .background(KinicDesign.appBackground)
                .navigationTitle("Conflicting change")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Load latest") { resolveConflict(keepMine: false) }
                            .tint(KinicDesign.hotPink)
                    }
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Keep mine") { resolveConflict(keepMine: true) }
                            .tint(KinicDesign.hotPink)
                    }
                }
                .interactiveDismissDisabled()
            }
        }
    }

    // MARK: - Actions

    private func load() async {
        loadState = .loading
        let databaseId = model.databaseId
        guard let loaded = await model.loadDetail(itemId) else {
            loadState = .failed(model.actionError ?? "This work item could not be loaded.")
            return
        }
        guard databaseId == model.databaseId else { return }
        detail = loaded
        loadState = .ready
    }

    private func beginEditing(_ detail: WorkItemDetail) {
        draftTitle = detail.item.title
        draftBody = detail.item.body
        isEditing = true
    }

    private func cancelEditing() {
        isEditing = false
        draftTitle = ""
        draftBody = ""
    }

    private func save(_ detail: WorkItemDetail) {
        Task {
            if await model.update(detail, title: draftTitle, body: draftBody) {
                isEditing = false
                await load()
            }
        }
    }

    private func changeState(_ detail: WorkItemDetail) async {
        let target: WorkItemState = detail.item.state == .open ? .closed : .open
        if await model.changeState(detail, to: target) {
            await load()
        }
    }

    private func postComment() async {
        let body = commentDraft
        if await model.postComment(itemId: itemId, body: body) {
            commentDraft = ""
            await load()
        }
    }

    /// Keeps the newest revision as the write base; the member decides which text to keep.
    private func resolveConflict(keepMine: Bool) {
        guard let conflict = model.conflict else {
            isShowingConflict = false
            return
        }
        detail = conflict.latest
        if keepMine {
            // Stay in the editor so the member can review and save against the new base.
            draftTitle = conflict.mine.title
            draftBody = conflict.mine.body
            isEditing = true
        } else {
            // The member gave up their own text, so its kept copy must not be offered again.
            model.abandonPendingEdits(itemId: itemId)
            draftTitle = conflict.latest.item.title
            draftBody = conflict.latest.item.body
            isEditing = false
        }
        model.clearConflict()
        isShowingConflict = false
    }

    private static func authorLabel(_ principal: String) -> String {
        InternetIdentityPresentation(principal: principal).compactPrincipal ?? principal
    }
}
