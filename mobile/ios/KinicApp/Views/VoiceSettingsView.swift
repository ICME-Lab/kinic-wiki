import SwiftUI

struct VoiceSettingsView: View {
    @Bindable var appModel: AppModel
    @State private var databaseID = ""
    @State private var principal = ""
    @State private var members: [DatabaseMember] = []
    @State private var access: VoiceAccessInfo?
    @State private var enabled = false
    @State private var budget = ""
    @State private var scope = "/Knowledge"
    @State private var busy = false
    @State private var message: String?
    private var owner: Bool { appModel.askAIDatabaseCandidates.first { $0.databaseId == databaseID }?.role == .owner }
    var body: some View {
        Form {
            Section("検索対象") {
                Picker("範囲", selection: $scope) { Text("Knowledge").tag("/Knowledge"); Text("Memory").tag("/Memory") }
                    .onChange(of: scope) { UserDefaults.standard.set(scope, forKey: "voice.scope.\(appModel.principalText)") }
            }
            Section("利用と予算") {
                Picker("データベース", selection: $databaseID) {
                    ForEach(appModel.askAIDatabaseCandidates) { Text($0.displayTitle).tag($0.databaseId) }
                }.disabled(busy)
                if owner {
                    Picker("利用者", selection: $principal) {
                        Text("自分").tag(appModel.principalText)
                        ForEach(members.filter { $0.principal != appModel.principalText }) { Text($0.principal).tag($0.principal) }
                    }.disabled(busy)
                }
                if busy { ProgressView() }
                if let access {
                    Toggle("音声を利用する", isOn: $enabled).disabled(!owner || busy)
                    LabeledContent("1日の上限（cycles）") { TextField("cycles", text: $budget).keyboardType(.numberPad).multilineTextAlignment(.trailing) }.disabled(!owner || busy)
                    LabeledContent("料金／分", value: "\(access.rate.cyclesPerMinute) cycles")
                    LabeledContent("本日の残り", value: "\(access.remainingCycles) cycles")
                    LabeledContent("DB残高", value: "\(access.balanceCycles) cycles")
                    Text("毎日9:00（日本時間／UTC 0:00）にリセット。無音・ミュート中も接続時間に含まれます。料金変更時も上限額は自動で増えません。").font(.caption)
                    if owner { Button("保存") { save() }.disabled(busy || UInt64(budget) == nil) }
                    else { Text("利用許可と予算はデータベースの所有者が変更できます。") }
                }
                if let message { Text(message) }
            }
        }
        .navigationTitle("音声設定")
        .task {
            scope = UserDefaults.standard.string(forKey: "voice.scope.\(appModel.principalText)") ?? "/Knowledge"
            principal = appModel.principalText
            databaseID = appModel.selectedAskAIDatabaseId
        }
        .onChange(of: databaseID) { principal = appModel.principalText }
        .onChange(of: appModel.principalText) { principal = appModel.principalText; access = nil; members = [] }
        .task(id: databaseID + "|" + principal) { await load() }
    }
    private func load() async {
        guard !databaseID.isEmpty, !principal.isEmpty else { return }
        busy = true; message = nil; access = nil
        defer { busy = false }
        do {
            let info = try await appModel.voiceAccess(databaseId: databaseID, principal: principal, initializeOwner: owner && principal == appModel.principalText)
            try Task.checkCancellation()
            access = info; enabled = info.policy.enabled; budget = String(info.policy.budget)
            members = owner ? try await appModel.voiceMembers(databaseId: databaseID) : []
        } catch is CancellationError {} catch { message = error.localizedDescription }
    }
    private func save() {
        guard let value = UInt64(budget), value <= UInt64(Int64.max) else { message = "有効なcycles額を入力してください。"; return }
        busy = true
        Task {
            do { try await appModel.saveVoicePolicy(databaseId: databaseID, principal: principal, enabled: enabled, budget: value); await load(); message = "保存しました。" }
            catch { message = error.localizedDescription; busy = false }
        }
    }
}
