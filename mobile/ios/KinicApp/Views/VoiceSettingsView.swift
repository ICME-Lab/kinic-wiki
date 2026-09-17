import SwiftUI

struct VoiceSettingsView: View {
    @Bindable var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var principal = ""
    @State private var members: [DatabaseMember] = []
    @State private var access: VoiceAccessInfo?
    @State private var enabled = false
    @State private var budget = ""
    @State private var unit = CycleBudgetUnit.cycles
    @State private var scope = "/Knowledge"
    @State private var busy = false
    @State private var message: String?
    @State private var pendingDatabase: String?
    @State private var pendingPrincipal: String?
    @State private var confirmDiscard = false
    @State private var closeRequested = false
    private var databaseID: String { appModel.selectedDatabaseId }
    private var owner: Bool { appModel.askAIDatabaseCandidates.first { $0.databaseId == databaseID }?.role == .owner }
    private var dirty: Bool {
        guard let access else { return false }
        return enabled != access.policy.enabled || unit.cycles(from: budget) != access.policy.budget
    }
    private var loadKey: String { appModel.principalText + "|" + databaseID + "|" + principal }

    var body: some View {
        Form {
            Section("検索対象") {
                Picker("範囲", selection: $scope) { Text("Knowledge").tag("/Knowledge"); Text("Memory").tag("/Memory") }
                    .disabled(appModel.databaseSelectionLocked)
                    .onChange(of: scope) { UserDefaults.standard.set(scope, forKey: "voice.scope.\(appModel.principalText)") }
            }
            Section("利用と予算") {
                Picker("データベース", selection: Binding(get: { databaseID }, set: { id in
                    guard id != databaseID else { return }
                    pendingDatabase = id
                    requestChange()
                })) {
                    ForEach(appModel.askAIDatabaseCandidates) { Text($0.displayTitle).tag($0.databaseId) }
                }.disabled(busy || appModel.databaseSelectionLocked)
                if appModel.databaseSelectionLocked { Text(AppModel.databaseSelectionLockMessage).font(.caption) }
                if owner {
                    Picker("利用者", selection: Binding(get: { principal }, set: { id in
                        pendingPrincipal = id
                        requestChange()
                    })) {
                        Text("自分").tag(appModel.principalText)
                        ForEach(members.filter { $0.principal != appModel.principalText }) { Text($0.principal).tag($0.principal) }
                    }.disabled(busy)
                }
                if busy { ProgressView() }
                if let access {
                    Toggle("音声を利用する", isOn: $enabled).disabled(!owner || busy)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("1日の上限")
                        TextField("上限額", text: $budget).keyboardType(.decimalPad)
                            .accessibilityLabel("1日の上限額")
                        Picker("単位", selection: Binding(get: { unit }, set: { next in
                            guard let value = unit.cycles(from: budget) else {
                                message = "有効な上限額を入力してから単位を変更してください。"; return
                            }
                            budget = next.text(for: value); unit = next
                        })) { ForEach(CycleBudgetUnit.allCases) { Text($0.title).tag($0) } }
                        if unit.cycles(from: budget) == nil {
                            Text("0以上の整数cyclesになる額を入力してください。上限は\(Int64.max) cyclesです。")
                                .font(.caption).foregroundStyle(.red)
                        }
                    }.disabled(!owner || busy)
                    cycleRow("料金／分", value: access.rate.cyclesPerMinute)
                    cycleRow("本日の残り", value: access.remainingCycles)
                    cycleRow("DB残高", value: access.balanceCycles)
                    DisclosureGroup("正確なcycles額") {
                        Text("1日の上限: \(access.policy.budget) cycles")
                        Text("料金／分: \(access.rate.cyclesPerMinute) cycles")
                        Text("本日の残り: \(access.remainingCycles) cycles")
                        Text("DB残高: \(access.balanceCycles) cycles")
                    }.font(.caption).textSelection(.enabled)
                    Text("毎日9:00（日本時間／UTC 0:00）にリセット。無音・ミュート中も接続時間に含まれます。料金変更時も上限額は自動で増えません。").font(.caption)
                    if owner { Button("保存") { save() }.disabled(busy || unit.cycles(from: budget) == nil) }
                    else { Text("利用許可と予算はデータベースの所有者が変更できます。") }
                }
                if let message { Text(message) }
            }
        }
        .navigationTitle("音声設定")
        .navigationBarBackButtonHidden(true)
        .toolbar { ToolbarItem(placement: .topBarLeading) {
            Button("戻る", systemImage: "chevron.left") { closeRequested = true; requestChange() }.disabled(busy)
        } }
        .interactiveDismissDisabled(dirty || busy)
        .confirmationDialog("未保存の変更を破棄しますか？", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("変更を破棄", role: .destructive) { applyChange() }
            Button("キャンセル", role: .cancel) { resetPending() }
        }
        .task {
            scope = UserDefaults.standard.string(forKey: "voice.scope.\(appModel.principalText)") ?? "/Knowledge"
            principal = appModel.principalText
        }
        .onChange(of: databaseID) { principal = appModel.principalText; access = nil; members = [] }
        .onChange(of: appModel.principalText) {
            principal = appModel.principalText; access = nil; members = []; resetPending()
            scope = UserDefaults.standard.string(forKey: "voice.scope.\(appModel.principalText)") ?? "/Knowledge"
        }
        .onChange(of: dirty || busy) { _, value in appModel.voiceSettingsHasChanges = value }
        .onDisappear { appModel.voiceSettingsHasChanges = false }
        .task(id: loadKey) { await load() }
    }
    private func cycleRow(_ title: String, value: UInt64) -> some View {
        Group {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                    Text(DatabaseManagementFormat.cycles(value)).foregroundStyle(.secondary)
                }
            } else {
                LabeledContent(title, value: DatabaseManagementFormat.cycles(value))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityIdentifier("voice.cycles.\(title)")
        .accessibilityValue("\(value) cycles")
    }
    private func requestChange() { if dirty { confirmDiscard = true } else { applyChange() } }
    private func resetPending() { pendingDatabase = nil; pendingPrincipal = nil; closeRequested = false }
    private func applyChange() {
        if closeRequested { dismiss() }
        else if let id = pendingDatabase { _ = appModel.requestBrowseDatabaseSelection(id) }
        else if let id = pendingPrincipal { principal = id }
        resetPending()
    }
    private func load() async {
#if DEBUG
        if ProcessInfo.processInfo.environment["KINIC_SCREENSHOT_MODE"] == "voice-settings" {
            access = .settingsPreview; enabled = true; unit = .billion; budget = "300"; return
        }
#endif
        let key = loadKey
        guard !databaseID.isEmpty, !principal.isEmpty else { access = nil; busy = false; return }
        busy = true; message = nil; access = nil
        defer { if key == loadKey { busy = false } }
        do {
            let db = databaseID, user = principal, isOwner = owner
            let info = try await appModel.voiceAccess(databaseId: db, principal: user, initializeOwner: isOwner && user == appModel.principalText)
            let loadedMembers = isOwner ? try await appModel.voiceMembers(databaseId: db) : []
            try Task.checkCancellation()
            guard key == loadKey else { return }
            access = info; enabled = info.policy.enabled
            unit = .preferred(for: info.policy.budget); budget = unit.text(for: info.policy.budget)
            members = loadedMembers
        } catch is CancellationError {} catch { if key == loadKey { message = error.localizedDescription } }
    }
    private func save() {
        guard let value = unit.cycles(from: budget) else { return }
        let key = loadKey, db = databaseID, user = principal, allowed = enabled
        busy = true
        Task {
            do {
                try await appModel.saveVoicePolicy(databaseId: db, principal: user, enabled: allowed, budget: value)
                guard key == loadKey else { return }
                await load(); message = "保存しました。"
            } catch { if key == loadKey { message = error.localizedDescription; busy = false } }
        }
    }
}
