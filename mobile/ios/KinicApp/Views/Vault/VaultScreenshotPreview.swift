// Where: mobile/ios/KinicApp/Views/Vault/VaultScreenshotPreview.swift
// What: Debug-only fixture host for inspecting Vault UI states on Simulator.
// Why: Enables visual review of list, detail, editor, generator, locked, and welcome screens without live services.

#if DEBUG
import KinicVaultCore
import SwiftUI

struct VaultScreenshotPreview: View {
    let screen: String
    @State private var model: VaultWorkspaceModel

    init(screen: String) {
        self.screen = screen
        switch screen {
        case "locked":
            _model = State(initialValue: .preview(.locked))
        case "welcome":
            _model = State(initialValue: .preview(.welcome))
        default:
            _model = State(initialValue: .preview(.unlocked))
        }
    }

    var body: some View {
        switch screen {
        case "detail":
            NavigationStack {
                if let first = model.items.first(where: { $0.kind == .credential }) {
                    VaultItemDetailView(model: model, objectId: first.objectIdBase64URL, showToast: { _ in })
                }
            }
        case "editor":
            if let first = model.items.first(where: { $0.kind == .credential }),
               let decrypted = try? model.decryptItem(objectId: first.objectIdBase64URL) {
                VaultItemEditorView(model: model, mode: .edit(decrypted), onSaved: { _ in })
            } else {
                VaultItemEditorView(model: model, mode: .create(.credential), onSaved: { _ in })
            }
        case "generator":
            VaultPasswordGeneratorSheet(onUse: { _ in })
        default:
            TabView(selection: .constant(AppTab.vault)) {
                Color.clear
                    .tabItem { Label("Home", systemImage: "house") }
                    .tag(AppTab.home)
                Color.clear
                    .tabItem { Label("Browse", systemImage: "folder") }
                    .tag(AppTab.browse)
                Color.clear
                    .tabItem { Label("Ask AI", systemImage: "sparkles") }
                    .tag(AppTab.askAI)
                VaultTabView(model: model)
                    .tabItem { Label("Vault", systemImage: "lock.shield") }
                    .tag(AppTab.vault)
                Color.clear
                    .tabItem { Label("Manage", systemImage: "slider.horizontal.3") }
                    .tag(AppTab.manage)
            }
        }
    }
}
#endif
