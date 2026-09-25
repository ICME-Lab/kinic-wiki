import Foundation

/// A DB-scoped projection of this device's Wiki capture history, not shared work items.
struct HomeCaptureSummary {
    let records: [SourceCaptureHistoryRecord]
    init(records: [SourceCaptureHistoryRecord], databaseId: String) {
        self.records = records.filter { $0.databaseId == databaseId }.sorted {
            if $0.item.requestedAtMilliseconds == $1.item.requestedAtMilliseconds { return $0.id > $1.id }
            return $0.item.requestedAtMilliseconds > $1.item.requestedAtMilliseconds
        }
    }
    var recent: [SourceCaptureHistoryRecord] { Array(records.prefix(3)) }
    var failed: [SourceCaptureHistoryRecord] { records.filter { $0.item.status == .failed } }
    var failedCount: Int { failed.count }
}

extension SourceCaptureHistoryStatus {
    var displayTitle: String {
        switch self {
        case .queued: "Queued"
        case .fetching: "Fetching"
        case .sourceWritten: "Source saved"
        case .generating: "Generating"
        case .completed: "Saved"
        case .failed: "Failed"
        }
    }
}
