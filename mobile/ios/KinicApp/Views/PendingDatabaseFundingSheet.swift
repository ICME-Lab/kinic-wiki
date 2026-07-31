// Where: mobile/ios/KinicApp/Views/PendingDatabaseFundingSheet.swift
// What: Explains pending activation and opens the database-specific funding page in the default browser.
// Why: A newly reserved database cannot store content until its first cycles purchase completes.

import SwiftUI

struct PendingDatabaseFundingSheet: View {
    let activation: PendingDatabaseActivation
    let onFundingPageReturned: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.scenePhase) private var scenePhase
    @State private var didCopyLink = false
    @State private var didOpenFundingPage = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Database", value: activation.databaseName)

                    Text("This database needs cycles before it can store content. Fund it on the web to activate it.")
                }

                Section {
                    Button("Open funding page", systemImage: "safari", action: openFundingPage)
                        .buttonStyle(.borderedProminent)
                        .tint(KinicDesign.hotPink)

                    Button(
                        didCopyLink ? "Funding link copied" : "Copy funding link",
                        systemImage: didCopyLink ? "checkmark" : "doc.on.doc",
                        action: copyFundingLink
                    )
                }

                Section {
                    Text("You may need to sign in with Internet Identity again and connect OISY or Plug on the web.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Database created")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now", action: dismiss.callAsFunction)
                }
            }
        }
        .onChange(of: scenePhase) {
            guard scenePhase == .active, didOpenFundingPage else {
                return
            }
            didOpenFundingPage = false
            onFundingPageReturned()
        }
    }

    private func openFundingPage() {
        didOpenFundingPage = true
        openURL(activation.fundingURL)
    }

    private func copyFundingLink() {
        UIPasteboard.general.url = activation.fundingURL
        didCopyLink = true
    }
}
