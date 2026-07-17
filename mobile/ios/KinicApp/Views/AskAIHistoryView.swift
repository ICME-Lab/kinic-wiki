// Where: mobile/ios/KinicApp/Views/AskAIHistoryView.swift
// What: On-device Ask AI history picker and deletion controls.
// Why: Persisted conversations need visible ownership and complete user deletion paths.

import SwiftUI

struct AskAIHistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var model: AskAIModel
    @State private var isConfirmingDeleteAll = false

    var body: some View {
        NavigationStack {
            Group {
                if model.conversations.isEmpty {
                    ContentUnavailableView(
                        "No conversations",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Completed Ask AI conversations are stored on this device.")
                    )
                } else {
                    List {
                        ForEach(model.conversations) { conversation in
                            Button {
                                model.selectConversation(conversation)
                                dismiss()
                            } label: {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(conversation.title)
                                        .foregroundStyle(.primary)
                                        .lineLimit(2)
                                    Text(conversation.databaseTitle)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                    Text(conversation.updatedAt, format: .dateTime.month().day().hour().minute())
                                        .font(.footnote)
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            .swipeActions {
                                Button("Delete", systemImage: "trash", role: .destructive) {
                                    model.deleteConversation(conversation)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Ask AI History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") {
                        dismiss()
                    }
                    .labelStyle(.iconOnly)
                }
                if !model.conversations.isEmpty {
                    ToolbarItem(placement: .destructiveAction) {
                        Button("Clear all", systemImage: "trash", role: .destructive) {
                            isConfirmingDeleteAll = true
                        }
                    }
                }
            }
            .confirmationDialog(
                "Delete all Ask AI conversations?",
                isPresented: $isConfirmingDeleteAll,
                titleVisibility: .visible
            ) {
                Button("Delete all", role: .destructive) {
                    model.deleteAllConversations()
                }
                Button("Cancel", role: .cancel) { }
            } message: {
                Text("This removes the saved questions, answers, and source references from this device.")
            }
        }
    }
}
