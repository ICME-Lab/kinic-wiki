// Where: mobile/ios/KinicApp/Models/ConversationLoadState.swift
// What: Explicit Ask AI history loading and recovery state.
// Why: A failed read must not become a writable empty history.

enum ConversationLoadState: Equatable {
    case loading
    case loaded
    case failed(String)
}
