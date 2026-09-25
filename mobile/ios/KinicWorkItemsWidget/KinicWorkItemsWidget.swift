// Where: mobile/ios/KinicWorkItemsWidget/KinicWorkItemsWidget.swift
// What: Home Screen widget listing the newest open work items of one database.
// Why: A glance must reach shared items without a network call or a signed-in session.

import SwiftUI
import WidgetKit

@main
struct KinicWorkItemsWidgetBundle: WidgetBundle {
    var body: some Widget {
        KinicWorkItemsWidget()
    }
}

struct KinicWorkItemsWidget: Widget {
    static let kind = "KinicWorkItemsWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: Self.kind,
            intent: WorkItemsWidgetIntent.self,
            provider: WorkItemsTimelineProvider()
        ) { entry in
            WorkItemsWidgetEntryView(entry: entry)
                .containerBackground(for: .widget) {
                    Color(red: 0.99, green: 0.98, blue: 1)
                }
        }
        .configurationDisplayName("Kinic Items")
        .description("The newest open items shared in a KinicWiki database.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

struct WorkItemsWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WorkItemWidgetSnapshot?
    let databaseId: String?
}

struct WorkItemsTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WorkItemsWidgetEntry {
        WorkItemsWidgetEntry(date: .now, snapshot: .previewPlaceholder, databaseId: "preview")
    }

    func snapshot(for configuration: WorkItemsWidgetIntent, in context: Context) async -> WorkItemsWidgetEntry {
        entry(for: configuration)
    }

    func timeline(for configuration: WorkItemsWidgetIntent, in context: Context) async -> Timeline<WorkItemsWidgetEntry> {
        // The app reloads every timeline whenever it rewrites the snapshot, so nothing here polls.
        Timeline(entries: [entry(for: configuration)], policy: .never)
    }

    private func entry(for configuration: WorkItemsWidgetIntent) -> WorkItemsWidgetEntry {
        let store = WorkItemWidgetSnapshotStore(appGroupId: Bundle.main.optionalString("APP_GROUP_ID"))
        return WorkItemsWidgetEntry(
            date: .now,
            snapshot: store.read(),
            databaseId: configuration.database?.id
        )
    }
}

private enum WidgetLinks {
    /// Used only when a generated link cannot be built, which keeps a tap from doing nothing.
    static let fallback = URL(string: "https://wiki.kinic.xyz/ios-work-items")!

    static func item(databaseId: String, itemId: String) -> URL {
        WorkItemUniversalLink.item(databaseId: databaseId, itemId: itemId) ?? fallback
    }

    static func compose(databaseId: String) -> URL {
        WorkItemUniversalLink.compose(databaseId: databaseId) ?? fallback
    }
}

private struct WorkItemsWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WorkItemsWidgetEntry

    private var accent: Color { Color(red: 0.96, green: 0.13, blue: 0.48) }

    private var database: WorkItemWidgetSnapshot.Database? {
        entry.snapshot?.database(id: entry.databaseId)
    }

    var body: some View {
        Group {
            if entry.snapshot == nil || entry.snapshot?.principal.isEmpty == true {
                message("Sign in", systemImage: "person.crop.circle.badge.questionmark")
            } else if entry.databaseId == nil {
                message("Choose a database", systemImage: "externaldrive.badge.questionmark")
            } else if let database, database.isAvailable {
                content(database)
            } else {
                message("This database is unavailable", systemImage: "lock")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func content(_ database: WorkItemWidgetSnapshot.Database) -> some View {
        let items = database.openItems(limit: family == .systemSmall ? 1 : 3)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(database.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if database.canWrite && database.isAvailable {
                    Link(destination: WidgetLinks.compose(databaseId: database.id)) {
                        Image(systemName: "plus.circle.fill")
                            .font(.body)
                            .foregroundStyle(accent)
                    }
                    .accessibilityLabel("New item")
                }
            }

            if items.isEmpty {
                Text("No open items")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(items, id: \.id) { item in
                    Link(destination: WidgetLinks.item(databaseId: database.id, itemId: item.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title.isEmpty ? "Untitled item" : item.title)
                                .font(.caption.weight(.semibold))
                                .lineLimit(family == .systemSmall ? 2 : 1)
                            HStack(spacing: 8) {
                                Text(Date(timeIntervalSince1970: Double(item.updatedAt) / 1000), style: .relative)
                                if item.commentCount > 0 {
                                    Label("\(item.commentCount)", systemImage: "bubble.left")
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            Spacer(minLength: 0)

            if let writtenAt = entry.snapshot?.writtenAt, writtenAt > 0 {
                Text(Date(timeIntervalSince1970: Double(writtenAt) / 1000), style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .widgetURL(WidgetLinks.compose(databaseId: database.id))
    }

    private func message(_ text: String, systemImage: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: systemImage)
                .font(.title3)
                .foregroundStyle(accent)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

private extension WorkItemWidgetSnapshot {
    static let previewPlaceholder = WorkItemWidgetSnapshot(
        version: WorkItemWidgetSnapshot.currentVersion,
        writtenAt: 0,
        principal: "preview",
        selectedDatabaseId: "preview",
        databases: [
            WorkItemWidgetSnapshot.Database(
                id: "preview",
                title: "Team Wiki",
                canWrite: true,
                isAvailable: true,
                updatedAt: 0,
                items: [
                    WorkItemWidgetSnapshot.Item(
                        id: "preview-1",
                        title: "Check the release notes",
                        state: .open,
                        commentCount: 2,
                        updatedAt: 0
                    ),
                    WorkItemWidgetSnapshot.Item(
                        id: "preview-2",
                        title: "Ask about the staging database",
                        state: .open,
                        commentCount: 0,
                        updatedAt: 0
                    )
                ]
            )
        ]
    )
}

#Preview(as: .systemSmall) {
    KinicWorkItemsWidget()
} timeline: {
    WorkItemsWidgetEntry(date: .now, snapshot: .previewPlaceholder, databaseId: "preview")
}
