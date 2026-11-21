// Where: mobile/ios/KinicApp/Views/Vault/VaultTabView.swift
// What: Main Kinic Vault password manager tab with search, categories, detail, editor, generator, and AutoFill status.
// Why: Gives users a daily-driver 1Password alternative inside Kinic with strict Wiki/Vault origin isolation.

import KinicVaultCore
import KinicVaultNative
import SwiftUI

struct VaultTabView: View {
    @Bindable var model: VaultWorkspaceModel

    @State private var isShowingGenerator = false
    @State private var editorKind: VaultDocumentKind?
    @State private var isShowingRenameVault = false
    @State private var renameDraft = ""
    @State private var renameError: String?
    @State private var toastMessage: String?
    @State private var toastTask: Task<Void, Never>?
    @State private var itemPendingDelete: VaultItemSummary?

    var body: some View {
        NavigationStack {
            Group {
                if model.isUnlocked {
                    unlockedListView
                } else if model.hasOfflineSnapshot {
                    lockedOfflineView
                } else if model.isSignedIn && model.vaults.isEmpty {
                    createFirstVaultView
                } else if model.isSignedIn {
                    signedInNeedsSyncView
                } else if model.canConnect {
                    signedOutWelcomeView
                } else {
                    unconfiguredView
                }
            }
            .navigationTitle(navigationTitle)
            .navigationBarTitleDisplayMode(.large)
            .toolbar { toolbarContent }
            .navigationDestination(for: String.self) { objectId in
                VaultItemDetailView(model: model, objectId: objectId, showToast: showToast)
            }
            .overlay(alignment: .bottom) {
                if let toastMessage {
                    Text(toastMessage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Color.black.opacity(0.84), in: Capsule())
                        .padding(.bottom, 16)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityAddTraits(.isStaticText)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: toastMessage)
        }
        .task {
            await model.prepareOnAppear()
        }
        .sheet(isPresented: $isShowingGenerator) {
            VaultPasswordGeneratorSheet()
        }
        .sheet(item: $editorKind) { kind in
            if model.isUnlocked {
                VaultItemEditorView(
                    model: model,
                    mode: .create(kind),
                    onSaved: { _ in
                        showToast(kind == .note ? "Note saved to Vault" : "Login saved to Vault")
                    }
                )
            }
        }
        .onChange(of: model.isUnlocked) { _, unlocked in
            if !unlocked {
                editorKind = nil
                itemPendingDelete = nil
                isShowingGenerator = false
            }
        }
        .alert("Rename Vault", isPresented: $isShowingRenameVault) {
            TextField("Vault name", text: $renameDraft)
            Button("Cancel", role: .cancel) { renameError = nil }
            Button("Save") {
                Task {
                    do {
                        try await model.renameSelectedVault(to: renameDraft)
                        showToast("Vault renamed")
                    } catch {
                        renameError = error.localizedDescription
                        showToast(error.localizedDescription)
                    }
                }
            }
        } message: {
            Text(renameError ?? "Enter a display name for this Vault (1–64 characters).")
        }
        .alert("Delete Item?", isPresented: Binding(
            get: { itemPendingDelete != nil },
            set: { if !$0 { itemPendingDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { itemPendingDelete = nil }
            Button("Delete", role: .destructive) {
                if let target = itemPendingDelete {
                    itemPendingDelete = nil
                    Task {
                        do {
                            try await model.deleteItem(target)
                            showToast("Deleted \"\(target.title)\"")
                        } catch {
                            showToast(error.localizedDescription)
                        }
                    }
                }
            }
        } message: {
            Text("This removes \"\(itemPendingDelete?.title ?? "this item")\" from your Vault and AutoFill cache.")
        }
    }

    private var navigationTitle: String {
        if let name = model.selectedVaultHeader?.name, !name.isEmpty, model.isUnlocked {
            return name
        }
        return "Vault"
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            if let mode = model.connectionMode, mode != .production {
                Text(mode.displayName.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(mode == .local ? .orange : KinicDesign.vaultIndigo)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(
                        (mode == .local ? Color.orange : KinicDesign.vaultIndigo).opacity(0.14),
                        in: Capsule()
                    )
            }
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                isShowingGenerator = true
            } label: {
                Image(systemName: "wand.and.stars")
            }
            .accessibilityLabel("Password Generator")

            if model.isUnlocked && model.canWrite {
                Menu {
                    Button("New Login", systemImage: "key.fill") {
                        editorKind = .credential
                    }
                    Button("New Secure Note", systemImage: "doc.text.fill") {
                        editorKind = .note
                    }
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Add Vault item")
            }

            if model.isUnlocked || model.isSignedIn || model.hasOfflineSnapshot {
                Menu {
                    if model.isSignedIn && model.vaults.count > 1 {
                        Menu("Switch Vault") {
                            ForEach(model.vaults) { vault in
                                Button {
                                    model.selectVault(vault.id)
                                } label: {
                                    if vault.id == model.selectedVault {
                                        Label(vault.name, systemImage: "checkmark")
                                    } else {
                                        Text(vault.name)
                                    }
                                }
                            }
                        }
                    }
                    if model.isSignedIn && model.selectedVaultHeader != nil {
                        Button("Sync Now", systemImage: "arrow.triangle.2.circlepath") {
                            Task { await model.synchronize() }
                        }
                        .disabled(model.busy)

                        Button("Rename Vault", systemImage: "pencil") {
                            renameDraft = model.selectedVaultHeader?.name ?? ""
                            renameError = nil
                            isShowingRenameVault = true
                        }
                    }
                    if model.isUnlocked {
                        Button("Lock Vault", systemImage: "lock.fill") {
                            model.lock()
                        }
                    }
                    Divider()
                    Button("Sign Out & Clear Offline Data", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                        model.signOut()
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("Vault options")
            }
        }
    }

    // MARK: - Unlocked List Surface

    private var unlockedListView: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    autoFillStatusCard
                    categoryFilterBar
                    if !model.availableTags.isEmpty {
                        tagFilterBar
                    }
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            if model.filteredItems.isEmpty {
                Section {
                    ContentUnavailableView {
                        Label(
                            model.items.isEmpty ? "No Saved Items Yet" : "No Matching Items",
                            systemImage: model.items.isEmpty ? "key.fill" : "magnifyingglass"
                        )
                    } description: {
                        Text(
                            model.items.isEmpty
                                ? "Tap + to save your first login or secure note."
                                : "Try a different search query, domain, or category."
                        )
                    } actions: {
                        if model.items.isEmpty && model.canWrite {
                            Button("New Login") {
                                editorKind = .credential
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(KinicDesign.actionPink)
                        } else if !model.searchQuery.isEmpty || model.selectedCategory != .all || model.selectedTag != nil {
                            Button("Clear Filters") {
                                model.searchQuery = ""
                                model.selectedCategory = .all
                                model.selectedTag = nil
                            }
                        }
                    }
                    .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    ForEach(model.filteredItems) { item in
                        NavigationLink(value: item.objectIdBase64URL) {
                            VaultItemRow(item: item)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if model.canWrite {
                                Button(role: .destructive) {
                                    itemPendingDelete = item
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            if item.kind == .credential {
                                Button {
                                    copyQuickCredential(item, field: .password)
                                } label: {
                                    Label("Password", systemImage: "key.fill")
                                }
                                .tint(KinicDesign.actionPink)
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if item.kind == .credential && item.hasTotp {
                                Button {
                                    copyQuickCredential(item, field: .totp)
                                } label: {
                                    Label("2FA", systemImage: "lock.rotation")
                                }
                                .tint(KinicDesign.vaultIndigo)
                            } else if !item.username.isEmpty {
                                Button {
                                    VaultClipboardHelper.copy(item.username, kind: .plain)
                                    showToast("Username copied")
                                } label: {
                                    Label("Username", systemImage: "person.fill")
                                }
                                .tint(KinicDesign.vaultIndigo)
                            }
                        }
                        .contextMenu {
                            if item.kind == .credential {
                                if !item.username.isEmpty {
                                    Button("Copy Username", systemImage: "person") {
                                        VaultClipboardHelper.copy(item.username, kind: .plain)
                                        showToast("Username copied")
                                    }
                                }
                                Button("Copy Password", systemImage: "key.fill") {
                                    copyQuickCredential(item, field: .password)
                                }
                                if item.hasTotp {
                                    Button("Copy 2FA Code", systemImage: "lock.rotation") {
                                        copyQuickCredential(item, field: .totp)
                                    }
                                }
                            }
                            if model.canWrite {
                                Button(
                                    item.favorite ? "Unfavorite" : "Favorite",
                                    systemImage: item.favorite ? "star.slash" : "star.fill"
                                ) {
                                    Task {
                                        do {
                                            try await model.toggleFavorite(for: item)
                                        } catch {
                                            showToast(error.localizedDescription)
                                        }
                                    }
                                }
                                Divider()
                                Button("Delete", systemImage: "trash", role: .destructive) {
                                    itemPendingDelete = item
                                }
                            }
                        }
                    }
                } header: {
                    Text("\(model.filteredItems.count) \(model.filteredItems.count == 1 ? "Item" : "Items")")
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(.compact)
        .searchable(
            text: $model.searchQuery,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search logins, domains, tags"
        )
        .refreshable {
            if model.isSignedIn {
                await model.synchronize()
            } else {
                await model.refreshAutoFillProviderState()
            }
        }
    }

    private var autoFillStatusCard: some View {
        HStack(spacing: 12) {
            Image(systemName: statusIconName)
                .font(.title3)
                .foregroundStyle(statusTintColor)
                .frame(width: 32)

            VStack(alignment: .leading, spacing: 2) {
                Text(statusHeadline)
                    .font(.subheadline.weight(.semibold))
                Text(statusSubheadline)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if model.busy {
                ProgressView()
            } else if model.isSignedIn {
                Button("Sync") {
                    Task { await model.synchronize() }
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.bordered)
                .tint(KinicDesign.hotPink)
            } else if model.canConnect {
                Button("Sign In") {
                    Task { await model.signIn() }
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderedProminent)
                .tint(KinicDesign.actionPink)
            }
        }
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var statusIconName: String {
        switch model.autoFillStatus {
        case .ready: "checkmark.shield.fill"
        case .syncing: "arrow.triangle.2.circlepath"
        case .providerDisabled: "exclamationmark.shield.fill"
        case .onlineOnly: "wifi"
        case .error: "exclamationmark.triangle.fill"
        case .notSynced: "lock.shield"
        }
    }

    private var statusTintColor: Color {
        switch model.autoFillStatus {
        case .ready: KinicDesign.successGreen
        case .syncing: KinicDesign.hotPink
        case .providerDisabled, .onlineOnly: .orange
        case .error: KinicDesign.errorRed
        case .notSynced: .secondary
        }
    }

    private var statusHeadline: String {
        switch model.autoFillStatus {
        case .ready(let count, _):
            "AutoFill Ready · \(count) \(count == 1 ? "login" : "logins")"
        case .syncing:
            "Syncing Vault…"
        case .providerDisabled:
            "Enable iOS AutoFill for QuickType"
        case .onlineOnly:
            "Vault Available Online"
        case .error:
            "AutoFill Sync Needs Attention"
        case .notSynced:
            "AutoFill Not Synced"
        }
    }

    private var statusSubheadline: String {
        switch model.autoFillStatus {
        case .ready(_, let syncedAt):
            "Synced \(syncedAt.formatted(.relative(presentation: .named)))" + (model.isSignedIn ? "" : " · Offline mode")
        case .syncing:
            "Updating encrypted snapshot and Keychain"
        case .providerDisabled(let count, _):
            "\(count) \(count == 1 ? "login" : "logins") cached · Turn on Kinic Vault in iOS Settings → AutoFill & Passwords"
        case .onlineOnly:
            "This Vault exceeds the offline AutoFill cache limit."
        case .error(let message):
            message
        case .notSynced:
            "Sign in and sync to use passwords across Safari & apps."
        }
    }

    private var categoryFilterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(VaultCategoryFilter.allCases) { category in
                    let isSelected = model.selectedCategory == category
                    let count = model.itemCount(for: category)
                    Button {
                        model.selectedCategory = category
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: category.systemImage)
                                .font(.caption2)
                            Text(category.displayName)
                                .font(.caption.weight(.semibold))
                            if count > 0 {
                                Text("\(count)")
                                    .font(.caption2.monospacedDigit())
                                    .opacity(0.8)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .foregroundStyle(isSelected ? .white : .primary)
                        .background(
                            isSelected ? KinicDesign.actionPink : Color(uiColor: .secondarySystemGroupedBackground),
                            in: Capsule()
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.trailing, 12)
        }
    }

    private var tagFilterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(model.availableTags, id: \.self) { tag in
                    let isSelected = model.selectedTag == tag
                    Button {
                        model.selectedTag = isSelected ? nil : tag
                    } label: {
                        Text("#\(tag)")
                            .font(.caption.weight(.medium))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .foregroundStyle(isSelected ? KinicDesign.hotPink : .secondary)
                            .background(
                                isSelected ? KinicDesign.hotPink.opacity(0.14) : Color(uiColor: .secondarySystemGroupedBackground),
                                in: Capsule()
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 4)
        }
    }

    // MARK: - Locked / Onboarding / Signed-Out States

    private var lockedOfflineView: some View {
        ScrollView {
            VStack(spacing: 22) {
                ZStack {
                    Circle()
                        .fill(KinicDesign.hotPink.opacity(0.12))
                        .frame(width: 96, height: 96)
                    Image(systemName: "faceid")
                        .font(.system(size: 44, weight: .light))
                        .foregroundStyle(KinicDesign.hotPink)
                }
                .padding(.top, 56)

                VStack(spacing: 8) {
                    Text("Kinic Vault is Locked")
                        .font(.title2.bold())
                    Text("Unlock with Face ID or your device passcode to access your encrypted logins and 2FA codes.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 28)

                VStack(spacing: 12) {
                    Button {
                        Task { await model.unlockWithDeviceAuthentication() }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "lock.open.fill")
                            Text("Unlock Vault")
                        }
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(KinicDesign.actionPink)

                    if model.isSignedIn && model.selectedVaultHeader != nil {
                        Button {
                            Task { await model.synchronize() }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                Text("Refresh Vault")
                            }
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .tint(KinicDesign.hotPink)
                        .disabled(model.busy)
                    }
                }
                .padding(.horizontal, 24)

                if !model.status.isEmpty {
                    Text(model.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                }
            }
        }
    }

    private var createFirstVaultView: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(KinicDesign.hotPink)
                    .padding(.top, 36)

                VStack(spacing: 8) {
                    Text("Create Your First Vault")
                        .font(.title2.bold())
                    Text("Your passwords, 2FA codes, and secure notes are encrypted end-to-end on your device before leaving your iPhone.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)

                Button {
                    Task { await model.createFirstVault() }
                } label: {
                    if model.busy {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Label("Create Vault", systemImage: "plus.circle.fill")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(KinicDesign.actionPink)
                .disabled(model.busy)
                .padding(.horizontal, 24)

                if !model.status.isEmpty {
                    Text(model.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
            }
        }
    }

    private var signedInNeedsSyncView: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "arrow.triangle.2.circlepath.circle.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(KinicDesign.hotPink)
                    .padding(.top, 36)

                VStack(spacing: 8) {
                    Text("Sync Your Vault")
                        .font(.title2.bold())
                    Text("Unlock with Face ID or your device passcode to sync and browse this Vault.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)

                if model.vaults.count > 1 {
                    Picker("Vault", selection: Binding(
                        get: { model.selectedVault },
                        set: { model.selectVault($0) }
                    )) {
                        ForEach(model.vaults) { vault in
                            Text(vault.name).tag(Optional(vault.id))
                        }
                    }
                    .pickerStyle(.menu)
                }

                Button {
                    Task { await model.unlockWithDeviceAuthentication() }
                } label: {
                    if model.busy {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else {
                        Label("Unlock & Sync Vault", systemImage: "lock.open.fill")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(KinicDesign.actionPink)
                .disabled(model.busy || model.selectedVault == nil)
                .padding(.horizontal, 24)

                if !model.status.isEmpty {
                    Text(model.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
            }
        }
    }

    private var signedOutWelcomeView: some View {
        ScrollView {
            VStack(spacing: 22) {
                ZStack {
                    Circle()
                        .fill(KinicDesign.hotPink.opacity(0.12))
                        .frame(width: 96, height: 96)
                    Image(systemName: "lock.shield.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(KinicDesign.hotPink)
                }
                .padding(.top, 28)

                VStack(spacing: 8) {
                    Text("Kinic Vault")
                        .font(.title.bold())
                    Text("Zero-knowledge password manager with iOS AutoFill, live 2FA codes, and offline Face ID unlock.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)

                VStack(alignment: .leading, spacing: 14) {
                    featureRow(icon: "key.fill", title: "End-to-End Encrypted", subtitle: "Your logins are encrypted on-device and protected in your iPhone Keychain.")
                    featureRow(icon: "rectangle.and.pencil.and.ellipsis", title: "System AutoFill & QuickType", subtitle: "Fill logins and auto-copy 2FA codes across Safari and every app.")
                    featureRow(icon: "person.badge.shield.checkmark.fill", title: "Isolated Vault Identity", subtitle: "Signs in separately from Kinic Wiki using Vault's dedicated origin.")
                }
                .padding(16)
                .kinicCard()
                .padding(.horizontal, 16)

                VStack(spacing: 12) {
                    Button {
                        Task { await model.signIn() }
                    } label: {
                        if model.busy {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                        } else {
                            HStack(spacing: 8) {
                                Image(systemName: "person.crop.circle")
                                Text("Sign in to Kinic Vault")
                            }
                            .font(.headline)
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 8)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(KinicDesign.actionPink)
                    .disabled(model.busy)

                    Button {
                        isShowingGenerator = true
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "wand.and.stars")
                            Text("Open Password Generator")
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .tint(KinicDesign.hotPink)
                }
                .padding(.horizontal, 24)

                if !model.status.isEmpty {
                    Text(model.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }
            }
            .padding(.bottom, 24)
        }
    }

    private var unconfiguredView: some View {
        ScrollView {
            VStack(spacing: 20) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 50))
                    .foregroundStyle(.secondary)
                    .padding(.top, 36)

                VStack(spacing: 8) {
                    Text("Vault Unavailable")
                        .font(.title3.bold())
                    Text(unconfiguredDescription)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 24)

                Button {
                    isShowingGenerator = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "wand.and.stars")
                        Text("Open Password Generator")
                    }
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .buttonBorderShape(.capsule)
                .tint(KinicDesign.actionPink)
                .padding(.horizontal, 24)
            }
        }
    }

    private var unconfiguredDescription: String {
#if DEBUG
        model.configurationError
            ?? "Configure KINIC_VAULT_CANISTER_ID in Kinic.xcconfig or KINIC_LOCAL_VAULT_CONFIG in Debug builds."
#else
        "Kinic Vault is temporarily unavailable in this build. You can still use the password generator below."
#endif
    }

    private func featureRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.body.weight(.semibold))
                .foregroundStyle(KinicDesign.hotPink)
                .frame(width: 24)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Quick Actions

    private enum QuickCopyField {
        case password
        case totp
    }

    private func copyQuickCredential(_ item: VaultItemSummary, field: QuickCopyField) {
        do {
            guard let decrypted = try model.decryptItem(objectId: item.objectIdBase64URL),
                  let cred = decrypted.credential else {
                showToast("Could not decrypt item.")
                return
            }
            switch field {
            case .password:
                guard !cred.password.isEmpty else {
                    showToast("No password saved.")
                    return
                }
                VaultClipboardHelper.copy(cred.password, kind: .password)
                showToast("Password copied · clears in 60s")
            case .totp:
                guard !cred.totp.isEmpty, let code = try? VaultTOTP.generate(input: cred.totp).code else {
                    showToast("No valid 2FA secret saved.")
                    return
                }
                VaultClipboardHelper.copy(code, kind: .totp)
                showToast("2FA code copied · clears in 90s")
            }
        } catch {
            showToast(error.localizedDescription)
        }
    }

    private func showToast(_ message: String) {
        toastTask?.cancel()
        toastMessage = message
        toastTask = Task {
            try? await Task.sleep(for: .seconds(2.4))
            if !Task.isCancelled {
                toastMessage = nil
            }
        }
    }
}

private struct VaultItemRow: View {
    let item: VaultItemSummary

    var body: some View {
        HStack(spacing: 12) {
            VaultItemBadge(summary: item, size: 38)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(item.title.isEmpty ? "Untitled" : item.title)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    if item.favorite {
                        Image(systemName: "star.fill")
                            .font(.caption2)
                            .foregroundStyle(KinicDesign.warmYellow)
                    }
                }

                if !item.username.isEmpty {
                    Text(item.username)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if let domain = item.domains.first {
                    Text(domain)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else if item.kind == .note {
                    Text("Secure Note")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 8)

            if item.hasTotp {
                Text("2FA")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(KinicDesign.vaultIndigo)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(KinicDesign.vaultIndigo.opacity(0.16), in: Capsule())
            }
        }
        .padding(.vertical, 2)
    }
}

extension VaultDocumentKind: @retroactive Identifiable {
    public var id: String { rawValue }
}

#Preview {
    VaultTabView(model: .preview())
}
