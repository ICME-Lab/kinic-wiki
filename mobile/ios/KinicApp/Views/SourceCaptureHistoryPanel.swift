// Where: mobile/ios/KinicApp/Views/SourceCaptureHistoryPanel.swift
// What: Recent and locally persisted source-capture history for the selected database.
// Why: Users need visible confirmation of device-pending, processing, completed, and failed captures.

import SwiftUI

struct SourceCaptureHistoryPanel: View {
    @Bindable var model: AppModel
    @State private var isShowingAll = false

    var body: some View {
        KinicPanel(
            title: "Capture history",
            systemImage: "clock.arrow.circlepath",
            trailing: {
                if !model.sourceCaptureHistory.isEmpty || !localItems.isEmpty {
                    Button("Show all") {
                        isShowingAll = true
                    }
                    .font(.subheadline.weight(.semibold))
                }
            }
        ) {
            if model.selectedDatabaseId.isEmpty {
                Text("Select a database to view capture history.")
                    .foregroundStyle(.secondary)
            } else if model.isLoadingSourceCaptureHistory && model.sourceCaptureHistory.isEmpty {
                ProgressView("Loading history…")
            } else if localItems.isEmpty && model.sourceCaptureHistory.isEmpty {
                Text("No captures yet.")
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(localItems) { item in
                        PendingCaptureHistoryRow(item: item, databaseTitle: databaseTitle)
                        Divider()
                    }
                    ForEach(model.sourceCaptureHistory.prefix(10)) { record in
                        SourceCaptureHistoryRow(
                            item: record.item,
                            databaseTitle: databaseTitle,
                            openTarget: { path in
                                model.openSourceCaptureTarget(path)
                            },
                            retry: {
                                Task { await model.retrySourceCapture(record) }
                            },
                            isRetrying: model.isRetryingSourceCapture(path: record.item.requestPath)
                        )
                        if record.id != model.sourceCaptureHistory.prefix(10).last?.id {
                            Divider()
                        }
                    }
                }
            }
        }
        .sheet(isPresented: $isShowingAll) {
            SourceCaptureHistoryView(model: model)
        }
    }

    private var localItems: [PendingSharedURL] {
        model.pendingURLs.filter { item in
            item.databaseId == nil || item.databaseId == model.selectedDatabaseId
        }
    }

    private var databaseTitle: String {
        model.selectedDatabase?.displayTitle ?? model.selectedDatabaseId
    }
}

private struct SourceCaptureHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                ForEach(model.pendingURLs.filter { $0.databaseId == nil || $0.databaseId == model.selectedDatabaseId }) { item in
                    PendingCaptureHistoryRow(item: item, databaseTitle: databaseTitle)
                }
                ForEach(model.sourceCaptureHistory) { record in
                    SourceCaptureHistoryRow(
                        item: record.item,
                        databaseTitle: databaseTitle,
                        openTarget: { path in
                            dismiss()
                            model.openSourceCaptureTarget(path)
                        },
                        retry: {
                            Task { await model.retrySourceCapture(record) }
                        },
                        isRetrying: model.isRetryingSourceCapture(path: record.item.requestPath)
                    )
                }
            }
            .navigationTitle("Capture history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task {
                await model.refreshSourceCaptureHistory(refreshAll: true)
            }
            .refreshable {
                await model.refreshSourceCaptureHistory(refreshAll: true)
            }
        }
    }

    private var databaseTitle: String {
        model.selectedDatabase?.displayTitle ?? model.selectedDatabaseId
    }
}

private struct PendingCaptureHistoryRow: View {
    let item: PendingSharedURL
    let databaseTitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.url.absoluteString)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            Text(databaseTitle)
                .font(.caption)
                .foregroundStyle(.secondary)
            Label("Waiting on this device", systemImage: "iphone")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
            Text(item.receivedAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
    }
}

private struct SourceCaptureHistoryRow: View {
    let item: SourceCaptureHistoryItem
    let databaseTitle: String
    let openTarget: (String) -> Void
    let retry: () -> Void
    let isRetrying: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.url)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            Text(databaseTitle)
                .font(.caption)
                .foregroundStyle(.secondary)
            Label(statusTitle, systemImage: statusImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(statusColor)
            Text(item.requestedAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let error = item.error, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let syncError = item.syncError, !syncError.isEmpty {
                Label("Status may be stale: \(syncError)", systemImage: "wifi.exclamationmark")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if isRetrying {
                ProgressView("Retrying…")
                    .font(.caption)
            } else if item.isRetryable() {
                Button("Retry", systemImage: "arrow.clockwise", action: retry)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
            }
            if let targetPath = item.targetPath {
                Button(targetPath) {
                    openTarget(targetPath)
                }
                .font(.caption)
                .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    private var statusTitle: String {
        switch item.status {
        case .queued: "Queued"
        case .fetching: "Fetching"
        case .sourceWritten: "Source saved"
        case .generating: "Generating"
        case .completed: "Saved"
        case .failed: "Failed"
        }
    }

    private var statusImage: String {
        switch item.status {
        case .completed: "checkmark.circle.fill"
        case .failed: "exclamationmark.triangle.fill"
        default: "clock.fill"
        }
    }

    private var statusColor: Color {
        switch item.status {
        case .completed: .green
        case .failed: .red
        default: KinicDesign.electricIndigo
        }
    }
}
