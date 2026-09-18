// Where: mobile/ios/KinicWorkItemsWidget/WorkItemsWidgetIntent.swift
// What: Per-widget database selection for the work items widget.
// Why: A widget instance must name its database without a canister or Keychain session.

import AppIntents
import Foundation

struct WorkItemsWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Kinic Items"
    static let description = IntentDescription("Choose the database this widget lists items from.")

    @Parameter(title: "Database")
    var database: WidgetDatabaseEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Items from \(\.$database)")
    }
}

struct WidgetDatabaseEntity: AppEntity {
    static let typeDisplayRepresentation: TypeDisplayRepresentation = "KinicWiki Database"
    static let defaultQuery = WidgetDatabaseQuery()

    let id: String
    let title: String

    init(id: String, title: String) {
        self.id = id
        self.title = title
    }

    init(database: WorkItemWidgetSnapshot.Database) {
        self.init(id: database.id, title: database.title)
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

struct WidgetDatabaseQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetDatabaseEntity] {
        let wanted = Set(identifiers)
        return Self.databases()
            .filter { wanted.contains($0.id) }
            .map(WidgetDatabaseEntity.init(database:))
    }

    func suggestedEntities() async throws -> [WidgetDatabaseEntity] {
        Self.databases().map(WidgetDatabaseEntity.init(database:))
    }

    /// Defaults to the database the app currently has selected, so a new widget needs no setup.
    func defaultResult() async -> WidgetDatabaseEntity? {
        let snapshot = Self.snapshot()
        let preferred = snapshot?.database(id: snapshot?.selectedDatabaseId)
        return (preferred ?? snapshot?.databases.first).map(WidgetDatabaseEntity.init(database:))
    }

    private static func snapshot() -> WorkItemWidgetSnapshot? {
        let store = WorkItemWidgetSnapshotStore(appGroupId: Bundle.main.optionalString("APP_GROUP_ID"))
        return store.read()
    }

    private static func databases() -> [WorkItemWidgetSnapshot.Database] {
        snapshot()?.databases ?? []
    }
}
