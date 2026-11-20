// Where: mobile/ios/KinicApp/Views/Vault/VaultItemDetailView.swift
// What: Decrypted detail view for Vault logins and secure notes with live TOTP and one-tap copy.
// Why: Plaintext is decrypted strictly on demand and cleared when the view disappears or Vault locks.

import KinicVaultCore
import SwiftUI

struct VaultTOTPLiveCard: View {
    let secret: String
    let onCopy: (String) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let code = try? VaultTOTP.generate(input: secret, now: context.date) {
                let progress = Double(code.remainingSeconds) / Double(max(1, code.period))
                let isExpiringSoon = code.remainingSeconds <= 5
                HStack(spacing: 14) {
                    ZStack {
                        Circle()
                            .stroke(Color.secondary.opacity(0.2), lineWidth: 3.5)
                        Circle()
                            .trim(from: 0, to: progress)
                            .stroke(
                                isExpiringSoon ? KinicDesign.errorRed : KinicDesign.hotPink,
                                style: StrokeStyle(lineWidth: 3.5, lineCap: .round)
                            )
                            .rotationEffect(.degrees(-90))
                            .animation(.linear(duration: 0.25), value: code.remainingSeconds)
                        Text("\(code.remainingSeconds)")
                            .font(.caption2.monospacedDigit().weight(.bold))
                            .foregroundStyle(isExpiringSoon ? KinicDesign.errorRed : .secondary)
                    }
                    .frame(width: 36, height: 36)
                    .accessibilityLabel("\(code.remainingSeconds) seconds remaining")

                    VStack(alignment: .leading, spacing: 2) {
                        Text("One-Time Password")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(VaultTOTP.formatCode(code.code))
                            .font(.system(.title2, design: .monospaced).weight(.semibold))
                            .foregroundStyle(isExpiringSoon ? KinicDesign.errorRed : .primary)
                            .contentTransition(.numericText())
                    }

                    Spacer()

                    Button {
                        onCopy(code.code)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.body)
                            .foregroundStyle(KinicDesign.hotPink)
                            .frame(width: 36, height: 36)
                            .background(KinicDesign.hotPink.opacity(0.12), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy one-time verification code")
                }
                .padding(.vertical, 4)
            } else {
                Label("Invalid TOTP secret or URI", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(KinicDesign.errorRed)
            }
        }
    }
}

struct VaultItemDetailView: View {
    @Bindable var model: VaultWorkspaceModel
    let objectId: String
    let showToast: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var decrypted: VaultDecryptedItem?
    @State private var loadError: String?
    @State private var isPasswordVisible = false
    @State private var revealedCustomFieldIndices: Set<Int> = []
    @State private var isShowingEditor = false
    @State private var confirmsDelete = false
    @State private var isDeleting = false

    private var summary: VaultItemSummary? {
        model.items.first(where: { $0.objectIdBase64URL == objectId }) ?? decrypted?.summary
    }

    var body: some View {
        Group {
            if let decrypted {
                detailForm(decrypted)
            } else if let loadError {
                ContentUnavailableView(
                    "Unable to Open Item",
                    systemImage: "exclamationmark.lock",
                    description: Text(loadError)
                )
            } else {
                ProgressView("Decrypting…")
            }
        }
        .navigationTitle(summary?.kind == .note ? "Secure Note" : "Login")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let decrypted, model.canWrite {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        Task { await toggleFavorite(decrypted.summary) }
                    } label: {
                        Image(systemName: decrypted.summary.favorite ? "star.fill" : "star")
                            .foregroundStyle(decrypted.summary.favorite ? KinicDesign.warmYellow : .secondary)
                    }
                    .accessibilityLabel(decrypted.summary.favorite ? "Remove from Favorites" : "Add to Favorites")

                    Button("Edit") {
                        isShowingEditor = true
                    }
                }
            }
        }
        .sheet(isPresented: $isShowingEditor, onDismiss: { reloadDecrypted() }) {
            if let decrypted {
                VaultItemEditorView(
                    model: model,
                    mode: .edit(decrypted),
                    onSaved: { _ in
                        reloadDecrypted()
                        showToast("Saved to Vault")
                    }
                )
            }
        }
        .alert("Delete Item?", isPresented: $confirmsDelete) {
            Button("Cancel", role: .cancel) {}
            Button("Delete", role: .destructive) {
                if let current = decrypted?.summary {
                    Task { await deleteItem(current) }
                }
            }
        } message: {
            Text("This removes \"\(summary?.title ?? "this item")\" from your Vault and AutoFill cache.")
        }
        .onAppear { reloadDecrypted() }
        .onDisappear {
            decrypted = nil
            isPasswordVisible = false
            revealedCustomFieldIndices.removeAll()
        }
        .onChange(of: model.isUnlocked) { _, unlocked in
            if !unlocked {
                decrypted = nil
                dismiss()
            }
        }
    }

    @ViewBuilder
    private func detailForm(_ item: VaultDecryptedItem) -> some View {
        Form {
            headerSection(item.summary)

            if let credential = item.credential {
                credentialSections(credential)
            } else if let noteText = item.noteText {
                noteSections(noteText)
            }

            if !item.summary.tags.isEmpty {
                Section("Tags") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(item.summary.tags, id: \.self) { tag in
                                Text("#\(tag)")
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 5)
                                    .background(KinicDesign.cardBackground, in: Capsule())
                            }
                        }
                    }
                }
            }

            Section {
                if !model.isSignedIn {
                    Label(
                        "Viewing offline snapshot. Sign in to Vault to edit or delete this item.",
                        systemImage: "wifi.slash"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                } else {
                    Button(role: .destructive) {
                        confirmsDelete = true
                    } label: {
                        if isDeleting {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Deleting…")
                            }
                        } else {
                            Label("Delete Item", systemImage: "trash")
                        }
                    }
                    .disabled(isDeleting || !model.canWrite)
                }
            } footer: {
                Text("Revision \(item.summary.revision) · End-to-end encrypted")
            }
        }
    }

    private func headerSection(_ summary: VaultItemSummary) -> some View {
        Section {
            HStack(spacing: 14) {
                VaultItemBadge(summary: summary, size: 46)
                VStack(alignment: .leading, spacing: 3) {
                    Text(summary.title.isEmpty ? "Untitled" : summary.title)
                        .font(.title3.weight(.semibold))
                    if let domain = summary.domains.first {
                        Text(domain)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(summary.kind == .note ? "Secure Note" : "Login")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func credentialSections(_ credential: VaultCredentialRecord) -> some View {
        Section("Credentials") {
            if !credential.username.isEmpty {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Username")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(credential.username)
                            .font(.body)
                            .textSelection(.enabled)
                    }
                    Spacer()
                    Button {
                        VaultClipboardHelper.copy(credential.username, kind: .plain)
                        showToast("Username copied")
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .frame(width: 40, height: 40)
                    }
                    .buttonStyle(.borderless)
                    .tint(KinicDesign.hotPink)
                    .accessibilityLabel("Copy username")
                }
            }

            if !credential.password.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Password")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if isPasswordVisible {
                                Text(credential.password)
                                    .font(.system(.body, design: .monospaced))
                                    .textSelection(.enabled)
                            } else {
                                Text(String(repeating: "•", count: min(20, max(8, credential.password.count))))
                                    .font(.system(.body, design: .monospaced))
                            }
                        }
                        Spacer()
                        Button {
                            isPasswordVisible.toggle()
                        } label: {
                            Image(systemName: isPasswordVisible ? "eye.slash" : "eye")
                                .frame(width: 36, height: 36)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel(isPasswordVisible ? "Hide password" : "Show password")

                        Button {
                            VaultClipboardHelper.copy(credential.password, kind: .password)
                            showToast("Password copied · clears in 60s")
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .frame(width: 40, height: 40)
                        }
                        .buttonStyle(.borderless)
                        .tint(KinicDesign.hotPink)
                        .accessibilityLabel("Copy password")
                    }

                    VaultPasswordStrengthBadge(password: credential.password)
                }
            }

            if !credential.totp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                VaultTOTPLiveCard(secret: credential.totp) { code in
                    VaultClipboardHelper.copy(code, kind: .totp)
                    showToast("2FA code copied · clears in 90s")
                }
            }
        }

        let urls = mergedURLs(credential)
        if !urls.isEmpty {
            Section("Websites") {
                ForEach(urls, id: \.self) { rawURL in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(rawURL)
                                .font(.subheadline)
                                .lineLimit(2)
                            if let domain = VaultCredentialCodec.normalizeDomain(rawURL) {
                                Text(domain)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if let openURL = launchableURL(rawURL) {
                            Link(destination: openURL) {
                                Image(systemName: "safari")
                                    .frame(width: 36, height: 36)
                            }
                            .buttonStyle(.borderless)
                            .tint(KinicDesign.hotPink)
                            .accessibilityLabel("Open \(rawURL)")
                        }
                        Button {
                            VaultClipboardHelper.copy(rawURL, kind: .plain)
                            showToast("URL copied")
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .frame(width: 36, height: 36)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Copy URL")
                    }
                }
            }
        }

        if !credential.customFields.isEmpty {
            Section("Custom Fields") {
                ForEach(Array(credential.customFields.enumerated()), id: \.offset) { index, field in
                    let isHidden = field.hidden == true
                    let revealed = !isHidden || revealedCustomFieldIndices.contains(index)
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(field.label.isEmpty ? "Field" : field.label)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if revealed {
                                Text(field.value)
                                    .font(isHidden ? .system(.body, design: .monospaced) : .body)
                                    .textSelection(.enabled)
                            } else {
                                Text(String(repeating: "•", count: min(16, max(6, field.value.count))))
                                    .font(.system(.body, design: .monospaced))
                            }
                        }
                        Spacer()
                        if isHidden {
                            Button {
                                if revealedCustomFieldIndices.contains(index) {
                                    revealedCustomFieldIndices.remove(index)
                                } else {
                                    revealedCustomFieldIndices.insert(index)
                                }
                            } label: {
                                Image(systemName: revealed ? "eye.slash" : "eye")
                                    .frame(width: 36, height: 36)
                            }
                            .buttonStyle(.borderless)
                            .foregroundStyle(.secondary)
                        }
                        Button {
                            VaultClipboardHelper.copy(field.value, kind: isHidden ? .secretField : .plain)
                            showToast(isHidden ? "\(field.label) copied · clears in 60s" : "\(field.label) copied")
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .frame(width: 36, height: 36)
                        }
                        .buttonStyle(.borderless)
                        .tint(KinicDesign.hotPink)
                    }
                }
            }
        }

        if !credential.notes.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Section("Notes") {
                Text(credential.notes)
                    .font(.body)
                    .textSelection(.enabled)
            }
        }
    }

    @ViewBuilder
    private func noteSections(_ noteText: String) -> some View {
        Section {
            if noteText.isEmpty {
                Text("No content")
                    .foregroundStyle(.secondary)
            } else {
                Text(noteText)
                    .font(.body)
                    .textSelection(.enabled)
            }
        } header: {
            HStack {
                Text("Secure Note")
                Spacer()
                if !noteText.isEmpty {
                    Button {
                        VaultClipboardHelper.copy(noteText, kind: .secretField)
                        showToast("Note copied · clears in 60s")
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                            .font(.caption.weight(.semibold))
                    }
                }
            }
        }
    }

    private func mergedURLs(_ credential: VaultCredentialRecord) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for candidate in [credential.url] + credential.urls {
            let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, seen.insert(trimmed).inserted else { continue }
            result.append(trimmed)
        }
        return result
    }

    private func launchableURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard VaultCredentialCodec.normalizeDomain(trimmed) != nil else { return nil }
        if trimmed.contains("://") {
            return URL(string: trimmed)
        }
        return URL(string: "https://\(trimmed)")
    }

    private func reloadDecrypted() {
        do {
            decrypted = try model.decryptItem(objectId: objectId)
            loadError = decrypted == nil ? "This item is no longer in the Vault." : nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func toggleFavorite(_ summary: VaultItemSummary) async {
        do {
            try await model.toggleFavorite(for: summary)
            reloadDecrypted()
        } catch {
            showToast(error.localizedDescription)
        }
    }

    private func deleteItem(_ summary: VaultItemSummary) async {
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await model.deleteItem(summary)
            showToast("Item deleted")
            dismiss()
        } catch {
            showToast(error.localizedDescription)
        }
    }
}

struct VaultItemBadge: View {
    let summary: VaultItemSummary
    var size: CGFloat = 38

    private var monogram: String {
        let source = summary.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = source.first {
            return String(first).uppercased()
        }
        return summary.kind == .note ? "N" : "L"
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
                .fill(summary.kind == .note ? KinicDesign.vaultIndigo.opacity(0.16) : KinicDesign.hotPink.opacity(0.14))
            if summary.kind == .note {
                Image(systemName: "doc.text.fill")
                    .font(.system(size: size * 0.44, weight: .semibold))
                    .foregroundStyle(KinicDesign.vaultIndigo)
            } else {
                Text(monogram)
                    .font(.system(size: size * 0.46, weight: .bold, design: .rounded))
                    .foregroundStyle(KinicDesign.hotPink)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

#Preview {
    let model = VaultWorkspaceModel.preview()
    NavigationStack {
        if let first = model.items.first {
            VaultItemDetailView(model: model, objectId: first.objectIdBase64URL, showToast: { _ in })
        }
    }
}
