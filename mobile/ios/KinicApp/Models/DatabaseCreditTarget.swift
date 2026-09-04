// Where: mobile/ios/KinicApp/Models/DatabaseCreditTarget.swift
// What: Explicit database destination for an App Store credit purchase.
// Why: A purchase sheet must keep the database selected when the sheet was opened.

struct DatabaseCreditTarget: Identifiable, Equatable {
    let id: String
    let title: String
}
