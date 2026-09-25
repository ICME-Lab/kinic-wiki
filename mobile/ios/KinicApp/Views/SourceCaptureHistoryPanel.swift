// Where: mobile/ios/KinicApp/Views/SourceCaptureHistoryPanel.swift
// What: Full device-local capture history and rows shared with Home.
// Why: Users need visible confirmation of device-pending, processing, completed, and failed captures.

import SwiftUI

struct SourceCaptureHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: AppModel

    private var localItems: [PendingSharedURL] {
        model.pendingURLs.filter { $0.databaseId == nil || $0.databaseId == model.selectedDatabaseId }
    }
    private var records: [SourceCaptureHistoryRecord] {
        HomeCaptureSummary(records: model.sourceCaptureHistory, databaseId: model.selectedDatabaseId).records
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label(databaseTitle, systemImage: "externaldrive")
                    Text("Wiki URL captures recorded on this device. Work items appear on Home.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if records.isEmpty && localItems.isEmpty {
                    if model.isLoadingSourceCaptureHistory { ProgressView("Loading history…") }
                    else { ContentUnavailableView("No captures yet", systemImage: "link", description: Text("Save a URL from Home to build your Wiki.")) }
                }
                ForEach(localItems) { item in
                    PendingCaptureHistoryRow(
                        item: item,
                        databaseTitle: databaseTitle,
                        isSubmitting: model.isSubmitting && model.pendingURLs.first?.id == item.id
                    )
                }
                ForEach(records) { record in
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
                        isRetrying: model.isRetryingSourceCapture(path: record.item.requestPath),
                        canRetry: model.selectedDatabase?.canWrite == true
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
            .task(id: model.selectedDatabaseId) {
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

struct PendingCaptureHistoryRow: View {
    let item: PendingSharedURL
    let databaseTitle: String
    var isSubmitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(item.url.absoluteString)
                .font(.subheadline.weight(.medium))
                .lineLimit(2)
            Text(item.databaseId == nil ? "No database chosen" : databaseTitle)
                .font(.caption)
                .foregroundStyle(.secondary)
            Label(isSubmitting ? "Sending…" : "Waiting on this device", systemImage: isSubmitting ? "arrow.up.circle" : "iphone")
                .font(.caption.weight(.semibold))
                .foregroundStyle(isSubmitting ? KinicDesign.electricIndigo : .orange)
            Text(item.receivedAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
    }
}

struct SourceCaptureHistoryRow: View {
    let item: SourceCaptureHistoryItem
    let databaseTitle: String
    let openTarget: (String) -> Void
    let retry: () -> Void
    let isRetrying: Bool
    var canRetry = true

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
            } else if canRetry && item.isRetryable() {
                Button("Retry", systemImage: "arrow.clockwise", action: retry)
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.bordered)
                    .frame(minHeight: 44)
            }
            if let targetPath = item.targetPath {
                Button("Open Wiki page", systemImage: "doc.text") {
                    openTarget(targetPath)
                }
                .font(.caption)
                .frame(minHeight: 44)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
        .accessibilityElement(children: .contain)
    }

    private var statusTitle: String { item.status.displayTitle }

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
