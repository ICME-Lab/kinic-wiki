// Where: mobile/ios/KinicApp/Views/Vault/VaultItemEditorView.swift
// What: Create and edit sheet for Vault credentials and secure notes via SaveInline.
// Why: Users need full 1Password-grade editing on iOS without dropping URLs, TOTP, tags, or custom fields.

import KinicVaultCore
import SwiftUI

struct VaultItemEditorView: View {
    enum Mode {
        case create(VaultDocumentKind)
        case edit(VaultDecryptedItem)

        var kind: VaultDocumentKind {
            switch self {
            case .create(let kind): kind
            case .edit(let item): item.summary.kind
            }
        }

        var existingSummary: VaultItemSummary? {
            if case .edit(let item) = self { return item.summary }
            return nil
        }

        var navigationTitle: String {
            switch self {
            case .create(.credential): "New Login"
            case .create(.note): "New Secure Note"
            case .create(.attachment): "New Item"
            case .edit(let item): item.summary.kind == .note ? "Edit Note" : "Edit Login"
            }
        }
    }

    private struct EditableCustomField: Identifiable, Equatable {
        let id = UUID()
        var label: String
        var value: String
        var hidden: Bool
    }

    @Bindable var model: VaultWorkspaceModel
    let mode: Mode
    let onSaved: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var title: String
    @State private var username: String
    @State private var password: String
    @State private var primaryURL: String
    @State private var extraURLs: [String]
    @State private var totp: String
    @State private var notes: String
    @State private var favorite: Bool
    @State private var tagsText: String
    @State private var customFields: [EditableCustomField]

    @State private var isPasswordVisible = false
    @State private var isTotpVisible = false
    @State private var isShowingGenerator = false
    @State private var isSaving = false
    @State private var saveError: String?
    @State private var confirmsDiscard = false
    @State private var isAdvancedExpanded = false

    private let initialFingerprint: String

    init(
        model: VaultWorkspaceModel,
        mode: Mode,
        onSaved: @escaping (String) -> Void
    ) {
        self.model = model
        self.mode = mode
        self.onSaved = onSaved

        let initTitle: String
        let initUsername: String
        let initPassword: String
        let initPrimaryURL: String
        let initExtraURLs: [String]
        let initTotp: String
        let initNotes: String
        let initFavorite: Bool
        let initTags: [String]
        let initCustomFields: [EditableCustomField]

        switch mode {
        case .create:
            initTitle = ""
            initUsername = ""
            initPassword = ""
            initPrimaryURL = ""
            initExtraURLs = []
            initTotp = ""
            initNotes = ""
            initFavorite = false
            initTags = []
            initCustomFields = []
        case .edit(let item):
            initTitle = item.summary.title
            initFavorite = item.summary.favorite
            initTags = item.summary.tags
            if let cred = item.credential {
                initUsername = cred.username
                initPassword = cred.password
                let primary = cred.url.trimmingCharacters(in: .whitespacesAndNewlines)
                initPrimaryURL = primary
                initExtraURLs = cred.urls.filter {
                    let t = $0.trimmingCharacters(in: .whitespacesAndNewlines)
                    return !t.isEmpty && t != primary
                }
                initTotp = cred.totp
                initNotes = cred.notes
                initCustomFields = cred.customFields.map {
                    EditableCustomField(label: $0.label, value: $0.value, hidden: $0.hidden ?? false)
                }
            } else {
                initUsername = ""
                initPassword = ""
                initPrimaryURL = ""
                initExtraURLs = []
                initTotp = ""
                initNotes = item.noteText ?? ""
                initCustomFields = []
            }
        }

        let initTagsText = initTags.joined(separator: ", ")
        _title = State(initialValue: initTitle)
        _username = State(initialValue: initUsername)
        _password = State(initialValue: initPassword)
        _primaryURL = State(initialValue: initPrimaryURL)
        _extraURLs = State(initialValue: initExtraURLs)
        _totp = State(initialValue: initTotp)
        _notes = State(initialValue: initNotes)
        _favorite = State(initialValue: initFavorite)
        _tagsText = State(initialValue: initTagsText)
        _customFields = State(initialValue: initCustomFields)
        _isAdvancedExpanded = State(initialValue: !initCustomFields.isEmpty || !initNotes.isEmpty || !initTagsText.isEmpty)

        self.initialFingerprint = Self.fingerprint(
            title: initTitle,
            username: initUsername,
            password: initPassword,
            primaryURL: initPrimaryURL,
            extraURLs: initExtraURLs,
            totp: initTotp,
            notes: initNotes,
            favorite: initFavorite,
            tagsText: initTagsText,
            customFields: initCustomFields
        )
    }

    private static func fingerprint(
        title: String,
        username: String,
        password: String,
        primaryURL: String,
        extraURLs: [String],
        totp: String,
        notes: String,
        favorite: Bool,
        tagsText: String,
        customFields: [EditableCustomField]
    ) -> String {
        let fields = customFields.map { "\($0.label)|\($0.value)|\($0.hidden)" }.joined(separator: ";")
        return [title, username, password, primaryURL, extraURLs.joined(separator: ","), totp, notes, "\(favorite)", tagsText, fields].joined(separator: "\u{1F}")
    }

    private var hasUnsavedChanges: Bool {
        Self.fingerprint(
            title: title,
            username: username,
            password: password,
            primaryURL: primaryURL,
            extraURLs: extraURLs,
            totp: totp,
            notes: notes,
            favorite: favorite,
            tagsText: tagsText,
            customFields: customFields
        ) != initialFingerprint
    }

    private var extractedDomains: [String] {
        VaultCredentialCodec.extractDomains([primaryURL] + extraURLs)
    }

    private var parsedTags: [String] {
        var seen = Set<String>()
        return Array(
            tagsText
                .split(separator: ",")
                .map { String($0.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64)) }
                .filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
                .prefix(32)
        )
    }

    private var totpValidationError: String? {
        let trimmed = totp.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        do {
            _ = try VaultTOTP.parse(trimmed)
            return nil
        } catch {
            return "Enter a valid Base32 secret or otpauth://totp/ URI."
        }
    }

    private var canSubmit: Bool {
        model.isUnlocked && !isSaving
            && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (mode.kind != .credential || totpValidationError == nil)
    }

    private var validationHint: String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter a title to enable Save."
        }
        if mode.kind == .credential, let totpValidationError {
            return totpValidationError
        }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if let saveError {
                    Section {
                        Label(saveError, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(KinicDesign.errorRed)
                            .font(.footnote)
                    }
                } else if let validationHint, hasUnsavedChanges {
                    Section {
                        Label(validationHint, systemImage: "info.circle")
                            .foregroundStyle(.secondary)
                            .font(.footnote)
                    }
                }

                Section {
                    TextField(mode.kind == .note ? "Note title" : "Title (e.g. GitHub)", text: $title)
                        .textInputAutocapitalization(.words)
                    Toggle(isOn: $favorite) {
                        HStack(spacing: 10) {
                            Image(systemName: favorite ? "star.fill" : "star")
                                .foregroundStyle(favorite ? KinicDesign.warmYellow : .secondary)
                            Text("Favorite")
                        }
                    }
                    .tint(KinicDesign.warmYellow)
                }

                if mode.kind == .credential {
                    credentialFormSections
                } else {
                    noteFormSection
                }

                Section {
                    TextField("Tags (comma separated, e.g. work, finance)", text: $tagsText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Tags")
                } footer: {
                    if !parsedTags.isEmpty {
                        Text("Tags: " + parsedTags.map { "#\($0)" }.joined(separator: " "))
                    }
                }
            }
            .navigationTitle(mode.navigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if hasUnsavedChanges {
                            confirmsDiscard = true
                        } else {
                            dismiss()
                        }
                    }
                    .disabled(isSaving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSaving {
                        ProgressView()
                    } else {
                        Button("Save") {
                            Task { await save() }
                        }
                        .fontWeight(.semibold)
                        .disabled(!canSubmit)
                    }
                }
            }
            .onChange(of: model.isUnlocked) { _, unlocked in
                if !unlocked { dismiss() }
            }
            .interactiveDismissDisabled(hasUnsavedChanges || isSaving)
            .alert("Discard Changes?", isPresented: $confirmsDiscard) {
                Button("Keep Editing", role: .cancel) {}
                Button("Discard", role: .destructive) { dismiss() }
            }
            .sheet(isPresented: $isShowingGenerator) {
                VaultPasswordGeneratorSheet { generated in
                    password = generated
                }
            }
        }
        .overlay {
            if scenePhase != .active {
                ZStack {
                    KinicDesign.appBackground
                        .ignoresSafeArea()
                    VStack(spacing: 12) {
                        Image(systemName: "lock.shield.fill")
                            .font(.system(size: 48))
                            .foregroundStyle(KinicDesign.hotPink)
                        Text("Kinic Vault")
                            .font(.title3.weight(.semibold))
                    }
                }
                .accessibilityHidden(true)
            }
        }
    }

    @ViewBuilder
    private var credentialFormSections: some View {
        Section("Login") {
            TextField("Username or email", text: $username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textContentType(.username)

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Group {
                        if isPasswordVisible {
                            TextField("Password", text: $password)
                                .font(.system(.body, design: .monospaced))
                        } else {
                            SecureField("Password", text: $password)
                                .font(.system(.body, design: .monospaced))
                        }
                    }
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                    Button {
                        isPasswordVisible.toggle()
                    } label: {
                        Image(systemName: isPasswordVisible ? "eye.slash" : "eye")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel(isPasswordVisible ? "Hide password" : "Show password")
                }

                HStack {
                    if !password.isEmpty {
                        VaultPasswordStrengthBadge(password: password)
                    }
                    Spacer()
                    Button {
                        isShowingGenerator = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "wand.and.stars")
                            Text("Generate")
                        }
                        .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(KinicDesign.hotPink)
                }
            }
        }

        Section {
            TextField("https://example.com", text: $primaryURL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .textContentType(.URL)

            ForEach(extraURLs.indices, id: \.self) { index in
                HStack {
                    TextField("Additional URL", text: $extraURLs[index])
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .textContentType(.URL)
                    Button(role: .destructive) {
                        extraURLs.remove(at: index)
                    } label: {
                        Image(systemName: "minus.circle.fill")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove URL")
                }
            }

            Button {
                extraURLs.append("")
            } label: {
                Label("Add Website", systemImage: "plus.circle")
            }
        } header: {
            Text("Websites")
        } footer: {
            if !extractedDomains.isEmpty {
                Text("AutoFill domains: " + extractedDomains.joined(separator: ", "))
            } else {
                Text("Add a website domain so Safari and apps can suggest this login automatically.")
            }
        }

        Section {
            HStack {
                Group {
                    if isTotpVisible {
                        TextField("Paste setup key or otpauth://totp/ URI", text: $totp)
                            .font(.system(.body, design: .monospaced))
                    } else {
                        SecureField("Paste setup key or otpauth://totp/ URI", text: $totp)
                            .font(.system(.body, design: .monospaced))
                    }
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

                Button {
                    isTotpVisible.toggle()
                } label: {
                    Image(systemName: isTotpVisible ? "eye.slash" : "eye")
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(isTotpVisible ? "Hide setup key" : "Show setup key")
            }

            if let totpValidationError {
                Text(totpValidationError)
                    .font(.caption)
                    .foregroundStyle(KinicDesign.errorRed)
            } else if !totp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VaultTOTPLiveCard(secret: totp) { code in
                    VaultClipboardHelper.copy(code, kind: .totp)
                }
            }
        } header: {
            Text("Two-Factor Authentication (TOTP)")
        } footer: {
            Text("Paste the Base32 setup key or otpauth:// URI from your service's 2FA setup.")
        }

        Section {
            DisclosureGroup("Custom Fields & Notes", isExpanded: $isAdvancedExpanded) {
                ForEach($customFields) { $field in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            TextField("Field label", text: $field.label)
                                .font(.subheadline.weight(.medium))
                            Button(role: .destructive) {
                                customFields.removeAll { $0.id == field.id }
                            } label: {
                                Image(systemName: "trash")
                                    .font(.caption)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("Remove custom field")
                        }
                        if field.hidden {
                            SecureField("Secret value", text: $field.value)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        } else {
                            TextField("Value", text: $field.value)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                        Toggle("Hide value", isOn: $field.hidden)
                            .font(.caption)
                    }
                    .padding(.vertical, 2)
                }

                Button {
                    customFields.append(EditableCustomField(label: "", value: "", hidden: false))
                } label: {
                    Label("Add Custom Field", systemImage: "plus.circle")
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text("Notes")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $notes)
                        .frame(minHeight: 88)
                }
            }
        } footer: {
            Text("Leaving the app locks the Vault and closes unsaved edits to protect your secrets.")
        }
    }

    private var noteFormSection: some View {
        Section("Secure Note") {
            TextEditor(text: $notes)
                .frame(minHeight: 220)
        }
    }

    private func save() async {
        saveError = nil
        isSaving = true
        defer { isSaving = false }

        do {
            let savedID: String
            switch mode.kind {
            case .credential:
                let cleanedFields = customFields
                    .map { field in
                        VaultCustomField(
                            label: field.label.trimmingCharacters(in: .whitespacesAndNewlines),
                            value: field.value,
                            hidden: field.hidden ? true : nil
                        )
                    }
                    .filter { !$0.label.isEmpty || !$0.value.isEmpty }
                let cleanedExtraURLs = extraURLs
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                let trimmedPrimary = primaryURL.trimmingCharacters(in: .whitespacesAndNewlines)
                let additionalLogins: [VaultAdditionalLogin]
                if case .edit(let item) = mode {
                    additionalLogins = item.credential?.additionalLogins ?? []
                } else {
                    additionalLogins = []
                }
                let record = VaultCredentialRecord(
                    label: title.trimmingCharacters(in: .whitespacesAndNewlines),
                    username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                    password: password,
                    url: trimmedPrimary,
                    urls: ([trimmedPrimary] + cleanedExtraURLs).filter { !$0.isEmpty },
                    additionalLogins: additionalLogins,
                    totp: totp.trimmingCharacters(in: .whitespacesAndNewlines),
                    notes: notes,
                    customFields: cleanedFields,
                    favorite: favorite,
                    tags: parsedTags
                )
                savedID = try await model.saveCredential(
                    existing: mode.existingSummary,
                    title: title,
                    record: record
                )
            case .note:
                savedID = try await model.saveNote(
                    existing: mode.existingSummary,
                    title: title,
                    body: notes,
                    favorite: favorite,
                    tags: parsedTags
                )
            case .attachment:
                throw VaultWorkspaceError.invalidInput("Attachments cannot be edited inline.")
            }
            onSaved(savedID)
            dismiss()
        } catch {
            saveError = error.localizedDescription
        }
    }
}

#Preview {
    VaultItemEditorView(
        model: .preview(),
        mode: .create(.credential),
        onSaved: { _ in }
    )
}
